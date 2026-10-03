import * as THREE from 'three';

// How the eye finds and follows the shuttle, drawn as crafted shaders rather than stock sprites:
//  - the beacon: a bright core, a crisp ring with a dark keyline (it reads on the white lines and
//    the bright crowd as well as on the green), and three short arcs orbiting it. When the shuttle
//    is yours to hit the ring tightens, turns gold and the arcs lock on as four corner ticks.
//  - the trail: a ribbon with a hot white core feathering to the shot's colour, wider and longer
//    with speed.
//  - the glint: a small four-point star that flashes on the cork at each contact.
//  - the pointer: when the shuttle leaves the view (a high lift or clear goes over the top of the
//    screen), a glowing marker pins to the edge right where it is, an arrow pointing at it and its
//    height in metres, so it is never lost.
// All three hold a constant size on screen (the caller passes pixels-per-metre at the shuttle).

const QUAD_VERTEX = `
  varying vec2 vUv;
  void main(){
    vUv = uv * 2.0 - 1.0;
    // camera-facing: expand the quad in view space around the object's origin
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 sc = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
    mv.xy += position.xy * sc;
    gl_Position = projectionMatrix * mv;
  }`;

const BEACON_FRAGMENT = `
  varying vec2 vUv;
  uniform vec3 uColor, uGold;
  uniform float uTime, uHit, uLive, uRing;
  float band(float r, float at, float w){ float aa = fwidth(r) * 1.2; return smoothstep(at - w - aa, at - w, r) * (1.0 - smoothstep(at + w, at + w + aa, r)); }
  void main(){
    float r = length(vUv), ang = atan(vUv.y, vUv.x);
    vec3 col = mix(uColor, uGold, uHit);
    float ringR = mix(0.56, 0.44, uHit);
    // the keyline: a soft dark ring just outside and inside the bright one, for contrast anywhere
    float key = band(r, ringR, 0.11) * 0.7;
    float ring = band(r, ringR, 0.05);
    // three arcs orbiting (free), or four corner ticks (locked on: yours to hit)
    float arcs = band(r, 0.8, 0.022) * step(0.62, fract(ang / 6.2831853 * 3.0 + uTime * 0.35));
    float ticks = band(r, 0.74 - 0.06 * sin(uTime * 9.0), 0.03) * step(0.86, fract(ang / 6.2831853 * 4.0 + 0.43));
    float orbit = mix(arcs, ticks, uHit) * uRing;
    ring *= uRing; key *= uRing;
    // no glow on the shuttle itself (it has its own ink outline): just the ring and its orbit
    vec3 add = col * (ring * 1.2 + orbit * 0.95);
    float a = key * (1.0 - ring) * uLive;
    gl_FragColor = vec4(add * uLive, a);
  }`;

const GLINT_FRAGMENT = `
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uSpin, uAmt;
  void main(){
    float c = cos(uSpin), s = sin(uSpin);
    vec2 p = mat2(c, -s, s, c) * vUv;
    // a four-point star: two thin crossed streaks and a round core
    float star = exp(-abs(p.x) * 26.0) * exp(-abs(p.y) * 3.2) + exp(-abs(p.y) * 26.0) * exp(-abs(p.x) * 3.2);
    float core = exp(-dot(p, p) * 30.0);
    vec3 col = mix(uColor, vec3(1.0), 0.65) * (star * 0.8 + core);
    gl_FragColor = vec4(col * uAmt, 0.0);
  }`;

const TRAIL_VERTEX = `
  attribute float alpha, side;
  varying float vA, vS;
  void main(){ vA = alpha; vS = side; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TRAIL_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA, vS;
  void main(){
    float x = abs(vS);
    float body = 1.0 - smoothstep(0.0, 1.0, x);   // feathered edges
    float core = exp(-x * x * 14.0);              // a hot thread down the middle
    vec3 col = mix(uColor, vec3(1.0), core * 0.5 * vA);
    float a = (body * 0.75 + core * 0.6) * vA * uOpacity;
    gl_FragColor = vec4(col * a, 0.0);
  }`;

const add = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };

export function createShuttleFx(scene) {
  const quad = new THREE.PlaneGeometry(2, 2);
  const beaconU = { uColor: { value: new THREE.Color(0xe4ff3c) }, uGold: { value: new THREE.Color(0xffc93c) }, uTime: { value: 0 }, uHit: { value: 0 }, uLive: { value: 1 }, uRing: { value: 1 } };
  const beacon = new THREE.Mesh(quad, new THREE.ShaderMaterial({ uniforms: beaconU, vertexShader: QUAD_VERTEX, fragmentShader: BEACON_FRAGMENT, ...add, depthTest: false }));
  beacon.frustumCulled = false; beacon.renderOrder = 21; beacon.name = 'Shuttle beacon'; scene.add(beacon);
  const glintU = { uColor: { value: new THREE.Color(0xffffff) }, uSpin: { value: 0 }, uAmt: { value: 0 } };
  const glint = new THREE.Mesh(quad, new THREE.ShaderMaterial({ uniforms: glintU, vertexShader: QUAD_VERTEX, fragmentShader: GLINT_FRAGMENT, ...add, depthTest: false }));
  glint.frustumCulled = false; glint.renderOrder = 22; scene.add(glint);

  const N = 26;
  const pts = Array.from({ length: N }, () => new THREE.Vector3());
  const tpos = new Float32Array(N * 2 * 3), al = new Float32Array(N * 2), sd = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { sd[i * 2] = -1; sd[i * 2 + 1] = 1; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tpos, 3)); g.setAttribute('alpha', new THREE.BufferAttribute(al, 1)); g.setAttribute('side', new THREE.BufferAttribute(sd, 1));
  const idx = []; for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } g.setIndex(idx);
  const trailU = { uColor: { value: new THREE.Color(0xe4ff3c) }, uOpacity: { value: 0.9 } };
  const trail = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: trailU, vertexShader: TRAIL_VERTEX, fragmentShader: TRAIL_FRAGMENT, ...add, side: THREE.DoubleSide }));
  trail.frustumCulled = false; trail.renderOrder = 3; scene.add(trail);

  let n = 0, acc = 0, fade = 0, time = 0, flare = 0, hitT = 0;
  const pointer = document.createElement('div');
  pointer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:6;display:none';
  pointer.innerHTML = '<div style="position:absolute;left:-23px;top:-23px;width:46px;height:46px;border-radius:50%;background:radial-gradient(circle,#fff 0 30%,rgba(228,255,60,.95) 31% 58%,rgba(228,255,60,0) 72%);box-shadow:0 0 0 3px #0d1838,0 0 18px rgba(228,255,60,.9);animation:shPtr .5s ease-in-out infinite alternate"></div>'
    + '<i style="position:absolute;left:-10px;top:-46px;width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;border-bottom:16px solid #e4ff3c;filter:drop-shadow(0 0 0 #0d1838) drop-shadow(0 2px 0 #0d1838)"></i>'
    + '<b style="position:absolute;left:-30px;top:28px;width:60px;text-align:center;font:700 14px Fredoka,Nunito,sans-serif;color:#fff;paint-order:stroke fill;-webkit-text-stroke:4px #0d1838"></b>';
  const ptrArrow = pointer.querySelector('i'), ptrText = pointer.querySelector('b');
  if (!document.getElementById('shPtrCss')) { const st = document.createElement('style'); st.id = 'shPtrCss'; st.textContent = '@keyframes shPtr{to{transform:scale(1.18)}}'; document.head.appendChild(st); }
  let pointerHost = null;
  const proj = new THREE.Vector3();
  const tmp = new THREE.Vector3(), side = new THREE.Vector3();

  return {
    beacon, glint, trail,
    // the contact: the trail takes the shot's colour, the glint flares
    hit(color, power = 0.5) { trailU.uColor.value.setHex(color); glintU.uColor.value.setHex(color); flare = Math.max(flare, 0.6 + power); },
    reset() { n = 0; trail.visible = false; pointer.style.display = 'none'; },
    // pos: the shuttle (world), speed m/s, pxPerM at its distance, coming at me, hittable now
    update({ dt, camera, pos, speed, pxPerM, live, coming, hittable, ring = true, host = null }) {
      time += dt;
      const px = m => m / pxPerM;
      beaconU.uTime.value = time;
      hitT += ((hittable ? 1 : 0) - hitT) * (1 - Math.exp(-dt * 14));
      beaconU.uHit.value = hitT;
      beaconU.uLive.value = live ? 1 : 0.4;
      beaconU.uColor.value.setHex(coming ? 0xe4ff3c : 0x9fd4ff);
      beacon.visible = true; beaconU.uRing.value = ring ? 1 : 0; beacon.position.copy(pos); beacon.scale.setScalar(px(44 + 6 * hitT));
      // glint: present at speed, flaring on contact
      flare = Math.max(0, flare - dt * 3.2);
      const amt = flare * 0.8; // a glint only on contact
      glint.visible = live && amt > 0.02; glint.position.copy(pos); glint.scale.setScalar(px(26 + 26 * Math.min(1.5, flare)));
      glintU.uAmt.value = amt; glintU.uSpin.value = time * 1.6;
      // the trail: one point per 1/60 s whatever the frame rate; the head follows every frame
      if (speed > 1.5 && live) {
        acc += dt;
        if (n === 0 || acc >= 1 / 60) { acc = n === 0 ? 0 : acc % (1 / 60); for (let i = N - 1; i > 0; i--) pts[i].copy(pts[i - 1]); n = Math.min(N, n + 1); }
        pts[0].copy(pos);
        trailU.uOpacity.value = Math.min(0.85, 0.5 + speed / 50);
      } else { fade += dt * 120; const k = Math.floor(fade); fade -= k; n = Math.max(0, n - k); }
      const width = px(9) + Math.min(0.07, speed * 0.0018);
      for (let i = 0; i < N; i++) {
        const k = Math.min(i, Math.max(0, n - 1)), p = pts[k], q = pts[Math.min(k + 1, Math.max(0, n - 1))];
        tmp.subVectors(k === 0 ? p : pts[k - 1], q); if (tmp.lengthSq() < 1e-8) tmp.set(1, 0, 0);
        side.subVectors(camera.position, p).cross(tmp).normalize();
        const f = n > 1 ? 1 - i / (n - 1) : 0, w = width * (0.25 + 0.75 * f);
        tpos.set([p.x + side.x * w, p.y + side.y * w, p.z + side.z * w, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w], i * 6);
        al[i * 2] = al[i * 2 + 1] = i < n ? f * f : 0;
      }
      g.attributes.position.needsUpdate = true; g.attributes.alpha.needsUpdate = true;
      trail.visible = n > 1;
      // the edge pointer, in the canvas's own box
      if (host && host !== pointerHost) { host.appendChild(pointer); pointerHost = host; }
      proj.copy(pos).project(camera);
      const off = proj.z < 1 && (proj.x < -0.98 || proj.x > 0.98 || proj.y < -0.97 || proj.y > 0.97);
      if (pointerHost && live && off) {
        const W = pointerHost.clientWidth, H = pointerHost.clientHeight;
        const m = 34, x = Math.min(W - m, Math.max(m, (proj.x + 1) / 2 * W)), y = Math.min(H - m, Math.max(m + 70, (1 - proj.y) / 2 * H));
        pointer.style.display = 'block'; pointer.style.transform = `translate(${x}px, ${y}px)`;
        // the arrow points from the marker toward where the shuttle really is
        const ang = Math.atan2((1 - proj.y) / 2 * H - y, (proj.x + 1) / 2 * W - x) + Math.PI / 2;
        ptrArrow.style.transform = `rotate(${ang}rad)`; ptrArrow.style.transformOrigin = '10px 46px';
        ptrText.textContent = pos.y.toFixed(1) + ' m';
      } else pointer.style.display = 'none';
    },
  };
}
