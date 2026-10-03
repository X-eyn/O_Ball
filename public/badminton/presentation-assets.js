export function presentationUrl(name) {
  return window.__MANIFEST?.presentation?.[name]?.url || `/badminton/assets/${name}`;
}
