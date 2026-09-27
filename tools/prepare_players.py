"""Build public/models/ from the Quaternius CC0 packs (https://quaternius.com).

Usage: python tools/prepare_players.py <folder with the two extracted packs>
  "Universal Base Characters[Standard]"   (character + hairstyles)
  "Universal Animation Library[Standard]" (animations)

Output (small, web-ready):
  body.glb, hair_*.glb   geometry only (materials are made in code)
  body_albedo.jpg   skin detail stored as a *linear ratio* to the average skin colour, so the
                    game can tint it to any skin tone (colour = tone * 2)
  body_normal.jpg, body_rough.jpg, hair_albedo.jpg, hair_normal.jpg, eye.png
  anims.json        the animation clips the game uses, in three.js AnimationClip JSON
"""
import json, os, shutil, struct, sys
from PIL import Image

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'models')
os.makedirs(OUT, exist_ok=True)
UBC = os.path.join(SRC, 'Universal Base Characters[Standard]')
TEX = os.path.join(UBC, 'Base Characters', 'Textures')
SIZE = 1024


def to_lin(v):
    v /= 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def jpg(src, dst, mode='RGB', q=90):
    Image.open(src).convert(mode).resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(OUT, dst), quality=q)


# ---- textures
body = Image.open(os.path.join(TEX, 'T_Superhero_Male_Ligh.png')).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
skin = [p for p in (body.get_flattened_data() if hasattr(body, "get_flattened_data") else body.getdata()) if p[0] > 120 and p[0] > p[1] > p[2] and p[0] - p[2] > 50]  # skin-coloured texels
skin.sort(key=lambda p: sum(p))
avg = skin[len(skin) // 2]
print('median skin colour', avg)
bands = []
for c, band in enumerate(body.split()):
    a = to_lin(float(avg[c]))
    bands.append(band.point([min(255, round(to_lin(float(v)) / a * 0.5 * 255)) for v in range(256)]))
Image.merge('RGB', bands).save(os.path.join(OUT, 'body_albedo.jpg'), quality=92)
jpg(os.path.join(TEX, 'Normals Unity - Godot', 'T_Superhero_Male_Normal.png'), 'body_normal.jpg', q=92)
jpg(os.path.join(TEX, 'T_Superhero_Male_Roughness.png'), 'body_rough.jpg', 'L')
jpg(os.path.join(TEX, 'T_Hair_1_BaseColor.png'), 'hair_albedo.jpg')
jpg(os.path.join(TEX, 'Normals Unity - Godot', 'T_Hair_1_Normal.png'), 'hair_normal.jpg', q=92)
shutil.copy(os.path.join(TEX, 'T_Eye_Brown.png'), os.path.join(OUT, 'eye.png'))


# ---- geometry: one self-contained .glb per model (no separate .bin requests, which some browser
# extensions block), dropping texture references (the game builds its own materials)
def geometry(src, name):
    g = json.load(open(src))
    for m in g.get('materials', []):
        pbr = m.get('pbrMetallicRoughness', {})
        for k in ('baseColorTexture', 'metallicRoughnessTexture'):
            pbr.pop(k, None)
        m.pop('normalTexture', None)
    for k in ('images', 'textures', 'samplers'):
        g.pop(k, None)
    buf = g['buffers'][0]
    data = open(os.path.join(os.path.dirname(src), buf.pop('uri')), 'rb').read()
    data += bytes(-len(data) % 4)
    buf['byteLength'] = len(data)
    js = json.dumps(g, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(data)
    with open(os.path.join(OUT, name + '.glb'), 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(data), 0x004E4942)); f.write(data)


geometry(os.path.join(UBC, 'Base Characters', 'Godot - UE', 'Superhero_Male_FullBody.gltf'), 'body')
HAIR = os.path.join(UBC, 'Hairstyles', 'Origin at 0', 'glTF (Godot)')
for h in ('Buzzed', 'BuzzedFemale', 'SimpleParted', 'Beard'):  # the short styles that use hair texture 1
    geometry(os.path.join(HAIR, f'Hair_{h}.gltf'), 'hair_' + h.lower())

# ---- animations: glTF channels -> three.js AnimationClip JSON (rotations everywhere, pelvis position)
KEEP = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Dance_Loop']
raw = open(os.path.join(SRC, 'Universal Animation Library[Standard]', 'Unreal-Godot', 'UAL1_Standard.glb'), 'rb').read()
jlen = struct.unpack_from('<I', raw, 12)[0]
gj = json.loads(raw[20:20 + jlen])
bin0 = 20 + jlen + 8
NCOMP = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}


def acc(i):
    a = gj['accessors'][i]
    bv = gj['bufferViews'][a['bufferView']]
    assert a['componentType'] == 5126, 'float accessors only'
    n = a['count'] * NCOMP[a['type']]
    off = bin0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return list(struct.unpack_from(f'<{n}f', raw, off))


clips = []
for an in gj['animations']:
    if an['name'] not in KEEP:
        continue
    tracks, dur = [], 0
    for ch in an['channels']:
        node = gj['nodes'][ch['target']['node']]['name']
        path = ch['target']['path']
        if path == 'scale' or (path == 'translation' and node != 'pelvis'):
            continue
        s = an['samplers'][ch['sampler']]
        times, vals = acc(s['input']), acc(s['output'])
        dur = max(dur, times[-1])
        tracks.append({'name': f'{node}.{"quaternion" if path == "rotation" else "position"}', 'type': 'quaternion' if path == 'rotation' else 'vector',
                       'times': [round(t, 4) for t in times], 'values': [round(v, 4) for v in vals]})
    clips.append({'name': an['name'], 'duration': round(dur, 4), 'tracks': tracks, 'blendMode': 2500})
json.dump(clips, open(os.path.join(OUT, 'anims.json'), 'w'), separators=(',', ':'))
print('clips', [c['name'] for c in clips])
open(os.path.join(OUT, 'LICENSE.txt'), 'w').write(
    'Character, hairstyles and animations: Quaternius (https://quaternius.com), CC0 1.0 Universal.\n'
    'Universal Base Characters + Universal Animation Library. Prepared with tools/prepare_players.py.\n')
