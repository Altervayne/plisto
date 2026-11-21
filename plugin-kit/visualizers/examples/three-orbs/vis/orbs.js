// A raw kind drawn with three.js, vendored beside the script. Three softly lit orbs circle the stage centre.
// Each orb's size follows the eased level and one band group, its glow follows the level, and the orbit
// speed follows the bass swell. Nothing is tied to a beat, so brightness only ever eases.
import * as THREE from "./vendor/three.module.min.js";

const GROUPS = ["bass", "mid", "high"];
const REST = { level: 0.35, bass: 0.3, mid: 0.2, high: 0.1 };

let renderer = null;
let scene = null;
let camera = null;
let orbs = [];
let width = 1;
let height = 1;
let orbit = 0;
let level = REST.level;
const groups = GROUPS.map((g) => REST[g]);

const toColor = (palette, i) => new THREE.Color(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]);

const fit = (layout) => {
  width = Math.max(1, layout.width);
  height = Math.max(1, layout.height);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
};

const paint = (palette) => {
  orbs.forEach((orb, i) => orb.material.color.copy(toColor(palette, i)));
};

// Moves a value toward its target with a time constant, so a step in the signal never steps on screen.
const ease = (value, target, dt) => value + (target - value) * (1 - Math.exp(-dt * 4));

const draw = (frame) => {
  const rest = frame.still;
  const sig = frame.sig;
  const dt = rest ? 0 : frame.dt;
  level = rest ? REST.level : ease(level, sig.level, dt);
  GROUPS.forEach((g, i) => {
    groups[i] = rest ? REST[g] : ease(groups[i], sig[g], dt);
  });
  // A paused track and a still frame hold the orbs where they are.
  if (frame.playing && !rest) orbit += dt * (0.15 + 0.6 * sig.swell);
  const spread = Math.min(width / height, 1.6) * 1.5;
  orbs.forEach((orb, i) => {
    const angle = orbit + (i * Math.PI * 2) / orbs.length;
    orb.position.set(Math.cos(angle) * spread * 0.6, Math.sin(angle * 1.3) * 0.45, Math.sin(angle) * 0.8);
    orb.scale.setScalar(0.5 + 0.5 * level + 0.6 * groups[i]);
    orb.material.emissiveIntensity = 0.15 + 0.6 * level;
  });
  renderer.render(scene, camera);
};

plistoVis.raw({
  setup(ctx) {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block";
    document.body.appendChild(canvas);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(0, 0, 6);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 4);
    scene.add(key);
    const geometry = new THREE.SphereGeometry(0.5, 48, 32);
    orbs = [0, 1, 2].map(() => {
      const material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 });
      material.emissive = material.color;
      const orb = new THREE.Mesh(geometry, material);
      scene.add(orb);
      return orb;
    });
    paint(ctx.palette);
    fit(ctx.layout);
    return canvas;
  },
  frame: draw,
  still: draw,
  resize: fit,
  theme(ctx) {
    paint(ctx.palette);
  },
  dispose() {
    orbs[0].geometry.dispose();
    orbs.forEach((orb) => orb.material.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  },
});
