import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";
import { routePose } from "./network.js";
import { insideMask, sampleMask } from "./mask.js";
import { TunnelCamera, clearSight, lumenRadius } from "./chase.js";
import { loadHumanData } from "./human-data.js";
import { surfaceGuard } from "./surface-guard.js";
import { steer, swim } from "./swim.js";
import { Race, readScores, saveScore } from "./race.js";
import { NavigationMap, humanChallenge } from "./navigation-map.js";
import { HeldInputs } from "./held-inputs.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Vessel Surfer",
  subtitle: "A Neurodesk easter egg",
  controlsContract: { about: "#about", cite: "#cite", privacy: "#privacy" },
});
const navigation = document.querySelector(".nd-imaging-navigation");
const back = navigation.querySelector("a");
back.href = "../../";
back.target = "_top";
back.textContent = "Back to website";
for (const id of ["about", "cite", "privacy"]) navigation.append($(id));
const themeButton = document.createElement("button");
function themeLabel() {
  const dark = document.documentElement.dataset.neurodeskTheme !== "light";
  themeButton.textContent = dark ? "Light" : "Dark";
  themeButton.setAttribute(
    "aria-label",
    dark ? "Use light theme" : "Use dark theme",
  );
}
themeButton.onclick = () => {
  document.documentElement.dataset.neurodeskTheme =
    document.documentElement.dataset.neurodeskTheme === "light"
      ? "dark"
      : "light";
  themeLabel();
};
themeLabel();
navigation.append(themeButton);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]"))
    parent.postMessage({ type: "close-voyage" }, location.origin);
});
const explanations = {
  about: [
    "Vessel Surfer",
    "A small submarine adventure inside a 3D vessel network. The default network is derived from the real IXI322 human brain MRA vessel segmentation published by Bizjak and colleagues. Routes follow its largest connected region, and the tunnel camera stays inside the segmented lumen. Reach the destination shown on the navigation map. Faster completion and fewer wall impacts earn more points. The five best completed runs are stored in this browser. Import a segmented NIfTI mask to explore your own vessels.",
  ],
  cite: [
    "Credits",
    "Made for Neurodesk. Rendering uses Three.js and its marching-cubes implementation; NIfTI decoding uses NIFTI-Reader-JS. Human data: IXI322-IOP-0891, IXI vascular segmentation dataset by Bizjak et al. (2022), doi:10.1117/12.2611756; Sobisch et al. (2022), PMLR 194:34–44. Source and derived assets: CC BY-NC-SA 4.0. The bundled source record lists processing changes and source URLs.",
  ],
  privacy: [
    "Your voyage stays here",
    "Vessel Surfer reads imported masks locally in a browser worker. The game does not upload your mask or save it to a server. The shared Neurodesk shell may collect site usage analytics. Reloading clears the imported data. High scores, completion times and bump counts stay in local browser storage; no scores are uploaded.",
  ],
};
for (const [id, [title, body]] of Object.entries(explanations))
  $(id).onclick = () => {
    pause();
    $("info-title").textContent = title;
    $("info-text").textContent = body;
    if (id === "cite" || id === "about") {
      const link = document.createElement("a");
      link.href = import.meta.env.BASE_URL + "data/ATTRIBUTION.md";
      link.textContent = " Dataset source, license and processing details";
      link.target = "_blank";
      link.rel = "noopener";
      $("info-text").append(link);
    }
    $("info").showModal();
  };
let pause = () => {};
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: $("ocean"),
    antialias: false,
    alpha: false,
  });
} catch {
  $("statusText").textContent =
    "3D rendering is unavailable. Enable WebGL or try another browser.";
  $("play").textContent = "WebGL unavailable";
}
if (renderer) boot();
function boot() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
  renderer.setClearColor(0x071820);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x071820, 0.003);
  const camera = new THREE.PerspectiveCamera(72, 1, 0.002, 600);
  const orbit = new OrbitControls(camera, $("ocean"));
  orbit.enableDamping = true;
  orbit.minDistance = 5;
  orbit.maxDistance = 260;
  scene.add(new THREE.HemisphereLight(0xffccc4, 0x33111a, 1.2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-30, 65, 60);
  scene.add(light);
  const fill = new THREE.PointLight(0x34bad5, 1800);
  fill.position.set(30, -30, -20);
  scene.add(fill);
  let vessels = new THREE.Group(),
    beacons = new THREE.Group();
  scene.add(vessels, beacons);
  const sub = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({
    color: 0xf6c653,
    metalness: 0.45,
    roughness: 0.28,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x254451,
    metalness: 0.7,
    roughness: 0.3,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9eecf2,
    emissive: 0x258d9e,
    emissiveIntensity: 0.65,
    metalness: 0.3,
    roughness: 0.1,
  });
  function part(geometry, material, position, scale) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    if (scale) mesh.scale.set(...scale);
    sub.add(mesh);
    return mesh;
  }
  part(new THREE.SphereGeometry(1, 24, 16), gold, [0, 0, 0], [0.7, 0.65, 1.35]);
  part(
    new THREE.SphereGeometry(0.46, 20, 12),
    glass,
    [0, 0.13, 0.99],
    [1, 0.9, 0.4],
  );
  part(new THREE.CylinderGeometry(0.3, 0.37, 0.5, 12), gold, [0, 0.75, -0.2]);
  part(new THREE.CylinderGeometry(0.09, 0.09, 0.65, 8), dark, [0, 1.23, -0.2]);
  part(new THREE.BoxGeometry(1.8, 0.1, 0.65), gold, [0, -0.12, -0.75]);
  const propeller = part(
    new THREE.BoxGeometry(1.1, 0.13, 0.1),
    dark,
    [0, 0, -1.48],
  );
  const lamp = new THREE.PointLight(0xffd873, 16, 14);
  lamp.position.set(0, 0, 1.8);
  lamp.intensity = 0;
  sub.add(lamp);
  scene.add(sub);
  // Floating particles establish depth without external textures or assets.
  const points = new Float32Array(1200);
  let seed = 37;
  for (let i = 0; i < points.length; i++) {
    seed = (seed * 16807) % 2147483647;
    points[i] = (seed / 2147483647 - 0.5) * 220;
  }
  const particles = new THREE.BufferGeometry();
  particles.setAttribute("position", new THREE.BufferAttribute(points, 3));
  scene.add(
    new THREE.Points(
      particles,
      new THREE.PointsMaterial({
        color: 0x7cacbe,
        size: 0.19,
        transparent: true,
        opacity: 0.5,
      }),
    ),
  );
  const vesselMaterial = new THREE.MeshPhongMaterial({
    color: 0xc94a68,
    emissive: 0x471322,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.42,
    shininess: 65,
    depthWrite: false,
  });
  const tunnel = new TunnelCamera();
  const headlamp = new THREE.PointLight(0xffc6ac, 5, 12, 1);
  scene.add(headlamp);
  const beaconGeometry = new THREE.TorusGeometry(0.92, 0.13, 8, 24),
    beaconMaterial = new THREE.MeshStandardMaterial({
      color: 0x7ffff0,
      emissive: 0x24d4b3,
      emissiveIntensity: 2,
    });
  let dirty = true;
  orbit.addEventListener("change", () => {
    dirty = true;
  });
  let network,
    mask = null,
    route,
    running = false,
    started = false,
    overview = true,
    travel = 0,
    won = false,
    loading = true;
  let human = null,
    humanPromise = null;
  const player = new THREE.Vector3();
  const direction = new THREE.Vector3(0, 1, 0),
    keys = new HeldInputs();
  const swimUp = new THREE.Vector3(0, 1, 0);
  let dragX = 0,
    dragY = 0;
  let race = new Race(),
    target = null,
    targetRadius = 0.35;
  const navigationMap = new NavigationMap($("map"));
  let scoreStorage;
  try {
    scoreStorage = window.localStorage;
  } catch {
    /* Storage can be disabled. */
  }
  const timeLabel = (seconds) => {
    const tenths = Math.floor(seconds * 10);
    return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
  };
  function showScores() {
    const rows = readScores(scoreStorage);
    $("score-rows").replaceChildren();
    if (!rows.length) {
      const row = $("score-rows").insertRow();
      const cell = row.insertCell();
      cell.colSpan = 3;
      cell.textContent = "No completed runs yet.";
    }
    for (const result of rows) {
      const row = $("score-rows").insertRow();
      for (const text of [
        result.points.toLocaleString(),
        timeLabel(result.seconds),
        result.bumps,
      ])
        row.insertCell().textContent = text;
    }
  }
  showScores();
  $("map-view").onclick = () => {
    navigationMap.axis = navigationMap.axis === 2 ? 1 : 2;
    $("map-view").textContent =
      navigationMap.axis === 2 ? "Front view" : "Top view";
    $("map-view").setAttribute(
      "aria-label",
      `Switch map to ${navigationMap.axis === 2 ? "front" : "top"} view`,
    );
  };
  function clear(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((item) => {
        if (!item.userData.sharedAsset && item.geometry !== beaconGeometry)
          item.geometry?.dispose();
      });
    }
  }
  function addBeacon(position, id) {
    const mesh = new THREE.Mesh(beaconGeometry, beaconMaterial);
    mesh.position.copy(position);
    mesh.userData.id = id;
    beacons.add(mesh);
  }
  function updateTunnel(dt, snap = false) {
    const volume = mask || human.volume;
    const unit = Math.min(...volume.scale);
    const radius = lumenRadius(volume, player);
    let ahead = player
      .clone()
      .addScaledVector(direction, Math.max(unit * 0.1, radius * 0.5));
    // The view follows the player's heading, including while braking at a wall.
    for (let d = radius * 3; d > unit * 0.001; d *= 0.65) {
      const candidate = player.clone().addScaledVector(direction, d);
      if (clearSight(volume, player, candidate)) {
        ahead.copy(candidate);
        break;
      }
    }
    if (!clearSight(volume, player, ahead)) {
      ahead.copy(player).addScaledVector(direction, unit * 0.005);
    }
    tunnel.up.copy(swimUp);
    tunnel.update(player, ahead, volume, dt, true);
    camera.position.copy(tunnel.position);
    camera.up.copy(tunnel.up);
    camera.lookAt(tunnel.target);
    camera.near = Math.max(0.0005, radius * 0.01);
    camera.far = Math.max(2, radius * 20);
    camera.updateProjectionMatrix();
    // Keep the sub below the sightline and small relative to the local lumen.
    const distance = Math.min(radius * 1.3, player.distanceTo(ahead) * 0.7);
    const subPoint = player
      .clone()
      .addScaledVector(tunnel.heading, distance)
      .addScaledVector(tunnel.up, -radius * 0.22);
    sub.visible =
      distance > unit * 0.04 && clearSight(volume, player, subPoint);
    sub.position.copy(subPoint);
    sub.scale.setScalar(Math.min(radius * 0.1, distance * 0.12));
    sub.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      tunnel.heading,
    );
    headlamp.position
      .copy(player)
      .addScaledVector(tunnel.heading, Math.min(radius * 0.1, distance * 0.1));
    headlamp.intensity = Math.max(0.15, radius * 9);
    headlamp.distance = Math.max(unit * 6, radius * 15);
    scene.fog.density = 0.12 / Math.max(radius, unit * 0.3);
    $("ocean").dataset.cameraInside = String(
      insideMask(volume, camera.position.toArray()),
    );
    $("ocean").dataset.cameraPosition = JSON.stringify(
      camera.position.toArray(),
    );
    $("ocean").dataset.cameraTarget = JSON.stringify(tunnel.target.toArray());
    $("ocean").dataset.clearView = String(
      clearSight(volume, camera.position, tunnel.target),
    );
  }
  function setView(value) {
    if (value && running) pause();
    dirty = true;
    overview = value;
    vesselMaterial.opacity = 1;
    vesselMaterial.transparent = false;
    vesselMaterial.depthWrite = true;
    vesselMaterial.needsUpdate = true;
    headlamp.visible = !value;
    scene.fog.density = value ? 0.003 : 0.12;
    orbit.enabled = value;
    for (const child of vessels.children) {
      if (child.name === "overview-surface") child.visible = value;
      if (child.name === "tunnel-surface") child.visible = !value;
    }
    $("view").setAttribute("aria-pressed", String(value));
    $("view").textContent = value ? "Dive view" : "Network view";
    if (value) {
      camera.far = 600;
      camera.updateProjectionMatrix();
      camera.up.set(0, 1, 0);
      camera.position.set(100, 58, 125);
      orbit.target.set(0, 2, 0);
      orbit.update();
      sub.visible = true;
      sub.position.copy(player);
      sub.scale.setScalar(mask ? Math.min(...mask.scale) * 0.22 : 0.5);
    } else {
      updateTunnel(0, true);
    }
  }
  function reset() {
    running = false;
    started = false;
    won = false;
    race = new Race(Math.min(...(mask || human.volume).scale) * 0.4);
    target = null;
    $("run-result").hidden = true;
    travel = 0;
    keys.clear();
    dragX = dragY = 0;
    swimUp.set(0, 1, 0);
    route = network ? { ...network.start } : null;
    clear(beacons);
    if (mask) {
      player.fromArray(mask.spawn);
      sub.scale.setScalar(Math.min(...mask.scale) * 0.22);

      direction.set(0, 0, 1);
      target =
        mask.targets
          .map((p) => new THREE.Vector3(...p))
          .filter((p) => insideMask(mask, p.toArray()))
          .sort((a, b) => b.distanceTo(player) - a.distanceTo(player))[0] ||
        player.clone();
      targetRadius = Math.min(...mask.scale) * 0.7;
    } else {
      sub.scale.setScalar(1);
      const pose = routePose(network, route);
      player.copy(pose.position);
      direction.copy(pose.direction);
      target = humanChallenge(network).target;
      targetRadius = 0.35;
    }
    addBeacon(target, "destination");
    beacons.children[0].scale.setScalar(targetRadius * 0.7);
    beaconMaterial.color.set(0xffd166);
    beaconMaterial.emissive.set(0xb57616);
    navigationMap.configure(
      network,
      mask,
      player,
      target,
      mask ? [] : humanChallenge(network).path,
    );
    $("mission-text").textContent = mask
      ? "Practice: reach the gold destination. Imported masks do not enter the high-score table."
      : "Reach the gold destination. Finish quickly and avoid wall bumps.";
    swimUp.addScaledVector(direction, -swimUp.dot(direction)).normalize();
    sub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    $("score").textContent = "0:00.0";
    $("bumps").textContent = "0 bumps";
    $("distance").textContent = "0 m traveled";
    $("play").textContent = "Launch submarine";
    $("play").disabled = false;
    $("view").disabled = false;
    $("reset").disabled = false;
    $("intro").hidden = false;
    $("mode").textContent = "SONAR ONLINE";
    $("statusText").textContent =
      "Ready to dive. Reach the gold destination on the map.";
    setView(true);
    updateControls();
  }
  async function loadDemo() {
    pause();
    const token = ++loadId;
    loading = true;
    $("play").disabled = $("view").disabled = $("reset").disabled = true;
    $("statusText").textContent =
      "Loading the human brain vessel segmentation…";
    try {
      humanPromise ||= loadHumanData().catch((error) => {
        humanPromise = null;
        throw error;
      });
      const data = await humanPromise;
      if (token !== loadId) return;
      human = data;
      mask = null;
      network = human.network;
      clear(vessels);
      const overviewMesh = new THREE.Mesh(human.geometry, vesselMaterial);
      overviewMesh.name = "overview-surface";
      overviewMesh.userData.sharedAsset = true;
      const detail = new THREE.Group();
      detail.name = "tunnel-surface";
      for (const geometry of human.chunks) {
        const mesh = new THREE.Mesh(geometry, vesselMaterial);
        mesh.userData.sharedAsset = true;
        detail.add(mesh);
      }
      vessels.add(overviewMesh, detail);
      loading = false;
      $("source-label").textContent =
        "Human brain · IXI322 MRA · Bizjak et al. · CC BY-NC-SA 4.0";
      $("help").textContent =
        "Steer directly with WASD / arrow keys, or drag in the tunnel. Up/down pitch; left/right turn. Hold Stop or Shift to brake while turning; hold Back or B to reverse. Set cruising speed below. Space pauses. Aim into an opening to choose a branch.";
      reset();
    } catch (error) {
      if (token !== loadId) return;
      loading = false;
      $("statusText").textContent = error.message;
      $("load-status").textContent = error.message;
      $("dataset").open = true;
    }
  }
  function updateControls() {
    dirty = true;
    $("reverse").hidden = false;
    for (const [id, label, hint] of [
      ["left", "←", "Turn left (A or left arrow)"],
      ["right", "→", "Turn right (D or right arrow)"],
      ["up", "↑", "Pitch up (W or up arrow)"],
      ["down", "↓", "Pitch down (S or down arrow)"],
      ["reverse", "Back", "Hold to reverse (B)"],
    ]) {
      $(id).textContent = label;
      $(id).setAttribute("aria-label", hint);
      $(id).title = hint;
    }
    $("location").textContent = "Free steering · WASD / arrows or drag";
  }
  function toggle() {
    if (loading || (!network && !mask)) return;
    if (won) reset();
    running = !running;
    if (running) race.resume(performance.now());
    else race.pause(performance.now());
    if (running) {
      if (overview) setView(false);
      started = true;
      $("intro").hidden = true;
      if (innerWidth < 701)
        $("viewer").scrollIntoView({ block: "start", behavior: "smooth" });
      $("ocean").focus({ preventScroll: true });
    }
    $("play").textContent = running
      ? "Pause voyage"
      : started
        ? "Resume voyage"
        : "Launch submarine";
    $("mode").textContent = running
      ? "EXPLORING"
      : started
        ? "PAUSED"
        : "SONAR ONLINE";
    $("statusText").textContent = running
      ? "Follow the map to the gold destination. Avoid wall bumps."
      : "Voyage paused.";
  }
  pause = () => {
    if (running) toggle();
    keys.clear();
    dragX = dragY = 0;
  };
  $("play").onclick = toggle;
  $("quick-play").onclick = toggle;
  $("view").onclick = () => {
    if (!loading && (network || mask)) setView(!overview);
  };
  $("reset").onclick = () => {
    if (!loading && (network || mask)) reset();
  };
  $("speed").oninput = () => {
    $("speed-value").textContent = `${$("speed").value}×`;
  };
  for (const [id, key] of [
    ["left", "arrowleft"],
    ["right", "arrowright"],
    ["up", "arrowup"],
    ["down", "arrowdown"],
    ["brake", "shift"],
    ["reverse", "b"],
  ]) {
    $(id).onpointerdown = (e) => {
      e.preventDefault();
      $(id).setPointerCapture(e.pointerId);
      keys.press(`pointer:${e.pointerId}`, key);
    };
    $(id).onpointerup =
      $(id).onpointercancel =
      $(id).onlostpointercapture =
        (e) => keys.release(`pointer:${e.pointerId}`);
    $(id).onkeydown = (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      if (e.repeat) return;
      keys.press(`button:${id}:${e.key}`, key);
    };
    $(id).onkeyup = (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      keys.release(`button:${id}:${e.key}`);
    };
    $(id).onblur = () => {
      keys.release(`button:${id}: `);
      keys.release(`button:${id}:Enter`);
    };
    $(id).onclick = (e) => {
      if (e.detail === 0) {
        if (key) {
          const source = `assistive:${id}`;
          if (keys.sources.has(source)) keys.release(source);
          else keys.press(source, key);
        }
      }
    };
  }
  window.addEventListener("keydown", (e) => {
    if (
      e.defaultPrevented ||
      e.target.closest(
        "input,select,textarea,summary,dialog,[contenteditable=true]",
      )
    )
      return;
    // Preserve native Enter/Space activation, but arrows still fly when a helm
    // button has focus after a mouse click or keyboard navigation.
    if (e.target.closest("button") && (e.key === " " || e.key === "Enter"))
      return;
    const k = e.key.toLowerCase();
    if (
      [
        "arrowleft",
        "arrowright",
        "arrowup",
        "arrowdown",
        "a",
        "d",
        "w",
        "s",
        " ",
        "shift",
        "b",
      ].includes(k)
    ) {
      e.preventDefault();
      keys.press(`keyboard:${k}`, k);
      if (!e.repeat) {
        if (k === " ") toggle();
      }
    }
  });
  window.addEventListener("keyup", (e) =>
    keys.release(`keyboard:${e.key.toLowerCase()}`),
  );
  window.addEventListener("blur", () => pause());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  let drag = null;
  $("ocean").addEventListener("pointerdown", (e) => {
    if (overview || !running) return;
    $("ocean").focus({ preventScroll: true });
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    $("ocean").setPointerCapture(e.pointerId);
  });
  $("ocean").addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    dragX += dx * 0.006;
    dragY -= dy * 0.006;
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    $("ocean").addEventListener(event, () => {
      drag = null;
    });
  let worker = null,
    loadId = 0;
  function cancelLoad() {
    loadId++;
    worker?.terminate();
    worker = null;
    loading = false;
    $("mask").disabled = false;
    $("play").disabled = !network && !mask;
    $("reset").disabled = !network && !mask;
  }
  $("demo").onclick = () => {
    cancelLoad();
    $("mask").value = "";
    $("load-status").textContent = "";
    loadDemo();
  };
  $("mask").onchange = async () => {
    const file = $("mask").files[0];
    if (!file) return;
    pause();
    cancelLoad();
    const token = loadId;
    loading = true;
    $("play").disabled = true;
    $("reset").disabled = true;
    $("mask").disabled = true;
    $("load-status").textContent = "Building your vessel surface…";
    $("statusText").textContent = "Loading segmentation…";
    try {
      if (file.size > 128 * 1024 * 1024)
        throw new Error("Choose a file smaller than 128 MB.");
      const data = await file.arrayBuffer();
      if (token !== loadId) return;
      const result = await new Promise((resolve, reject) => {
        worker = new Worker(new URL("./mask-worker.js", import.meta.url), {
          type: "module",
        });
        worker.onmessage = ({ data }) =>
          data.error ? reject(new Error(data.error)) : resolve(data.mask);
        worker.onerror = () =>
          reject(
            new Error("Could not decode this mask. Try another NIfTI file."),
          );
        worker.postMessage(data, [data]);
      });
      if (token !== loadId) return;
      const surface = new MarchingCubes(
        result.n,
        vesselMaterial,
        false,
        false,
        300000,
      );
      surface.isolation = 0.5;
      surface.field.set(result.field);
      surface.update();
      surface.onBeforeRender = () => {};
      surface.scale.set(...result.scale.map((v) => (v * result.n) / 2));
      if (surface.count >= 300000 * 3) {
        surface.geometry.dispose();
        throw new Error(
          "Surface is too complex for this game. Try a smaller vessel mask.",
        );
      }
      // Build the guard in world units, using only emitted marching-cubes faces.
      const count = surface.geometry.drawRange.count;
      const collisionGeometry = new THREE.BufferGeometry();
      collisionGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(
          surface.geometry.attributes.position.array.slice(0, count * 3),
          3,
        ),
      );
      collisionGeometry.scale(
        surface.scale.x,
        surface.scale.y,
        surface.scale.z,
      );
      Object.assign(result, surfaceGuard(collisionGeometry));
      clear(vessels);
      vessels.add(surface);
      mask = result;
      reset();
      $("source-label").textContent = `Local mask: ${file.name}`;
      $("load-status").textContent =
        `Loaded ${result.voxels.toLocaleString()} game voxels in the largest connected vessel region.`;
      $("help").textContent =
        "Free swim: ← / → or A / D turn. ↑ / ↓ or W / S pitch up and down. The sub moves forward automatically; Space pauses. Drag to steer. Hold Stop or Shift to brake while turning; hold Back or B to reverse away from a wall. Restart returns to the entry point.";
    } catch (error) {
      if (token === loadId) {
        $("load-status").textContent = error.message;
        $("statusText").textContent =
          "Mask could not load. Your previous network is still available.";
      }
    } finally {
      if (token === loadId) cancelLoad();
    }
  };
  function resize() {
    dirty = true;
    const { width, height } = $("viewer").getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe($("viewer"));
  $("ocean").addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    pause();
    $("play").disabled = true;
    $("statusText").textContent =
      "Graphics connection lost. Reload the page to restart.";
  });
  loadDemo();
  resize();
  let last = 0,
    frames = 0;
  renderer.setAnimationLoop((time) => {
    const dt = Math.min((time - last) / 1000, 0.08);
    last = time;
    if (running) {
      race.tick(performance.now());
      const volume = mask || human.volume;
      const horizontal =
        (keys.has("arrowright") || keys.has("d") ? 1 : 0) -
        (keys.has("arrowleft") || keys.has("a") ? 1 : 0);
      const vertical =
        (keys.has("arrowup") || keys.has("w") ? 1 : 0) -
        (keys.has("arrowdown") || keys.has("s") ? 1 : 0);
      steer(
        direction,
        swimUp,
        horizontal * dt * 1.5 + dragX,
        vertical * dt * 1.5 + dragY,
      );
      dragX = dragY = 0;
      let speed =
        Number($("speed").value) * (mask ? Math.min(...mask.scale) * 2 : 1.5);
      if (keys.has("shift")) speed = 0;
      if (keys.has("b")) speed *= -0.7;
      const next = swim(
        volume,
        player,
        direction.clone().multiplyScalar(dt * speed),
      );
      const moved = player.distanceTo(next);
      race.movement(Math.abs(dt * speed), moved);
      travel += moved;
      player.copy(next);
      $("mode").textContent = keys.has("shift")
        ? "BRAKING · STEER TO AIM"
        : Math.abs(speed) > 0 && moved < Math.abs(speed * dt) * 0.1
          ? "WALL · TURN OR REVERSE"
          : "EXPLORING";
      sub.quaternion.slerp(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          direction,
        ),
        1 - Math.exp(-dt * 7),
      );
      propeller.rotation.z += dt * 24;
      if (
        target &&
        player.distanceTo(target) <= targetRadius &&
        clearSight(volume, player, target)
      ) {
        const result = race.finish(performance.now());
        won = true;
        running = false;
        keys.clear();
        $("play").textContent = "Race again";
        $("mode").textContent = "DESTINATION REACHED";
        const message = `${mask ? "Practice complete" : `${result.points.toLocaleString()} points`} · ${timeLabel(result.seconds)} · ${result.bumps} wall bumps`;
        $("run-result").textContent = message;
        $("run-result").hidden = false;
        $("statusText").textContent = message;
        if (!mask) {
          const saved = saveScore(scoreStorage, result);
          $("score-storage").textContent = saved
            ? "Best five completed runs, saved on this device. Imported masks are practice only."
            : "Browser storage is unavailable. This result could not be saved.";
          showScores();
          $("highscores").open = true;
        }
      }
    }
    $("score").textContent = timeLabel(race.seconds);
    $("bumps").textContent = `${race.bumps} bump${race.bumps === 1 ? "" : "s"}`;
    if (target) {
      navigationMap.draw(player, direction);
      const units = mask ? "units" : "mm";
      $("target-distance").textContent =
        `${player.distanceTo(target).toFixed(1)} ${units} to target · ${Math.abs(target.y - player.y).toFixed(1)} ${target.y >= player.y ? "above" : "below"}`;
      $("map").setAttribute(
        "aria-label",
        `Vessel map. ${$("target-distance").textContent}. Cyan arrow: you. Gold diamond: destination.`,
      );
    }
    if (!overview && (mask || human)) {
      const before = camera.position.clone();
      const rotation = camera.quaternion.clone();
      updateTunnel(dt);
      if (
        before.distanceTo(camera.position) > 0.005 ||
        rotation.angleTo(camera.quaternion) > 0.0001
      )
        dirty = true;
    } else {
      orbit.update();
      sub.position.copy(player);
    }
    for (const b of beacons.children) {
      b.userData.baseScale ??= b.scale.x;
      b.scale.setScalar(
        overview
          ? b.userData.baseScale
          : Math.min(
              b.userData.baseScale,
              camera.position.distanceTo(b.position) * 0.045,
            ),
      );
      b.lookAt(camera.position);
    }
    if (++frames % 12 === 0)
      $("distance").textContent = `${Math.floor(travel)} ${
        mask ? "units" : "mm"
      } traveled`;
    if (dirty || running) {
      renderer.render(scene, camera);
      dirty = false;
    }
    // Read-only telemetry for accessible integrations and browser verification.
    $("quick-play").textContent = running
      ? "Ⅱ"
      : started && !won
        ? "▶"
        : "Dive";
    $("quick-play").disabled = loading;
    $("ocean").dataset.state = won
      ? "complete"
      : running
        ? "running"
        : started
          ? "paused"
          : "ready";
    $("ocean").dataset.distance = travel.toFixed(2);
    $("ocean").dataset.source = mask
      ? "local-mask"
      : human
        ? "IXI322-human-MRA"
        : "loading";
    $("ocean").dataset.position = JSON.stringify(player.toArray());
    $("ocean").dataset.heading = JSON.stringify(direction.toArray());
    $("ocean").dataset.elapsed = race.seconds.toFixed(3);
    $("ocean").dataset.bumps = String(race.bumps);
    $("ocean").dataset.target = target ? JSON.stringify(target.toArray()) : "";
    $("ocean").dataset.held = [...keys].join(",");
    for (const [id, names] of [
      ["left", ["arrowleft", "a"]],
      ["right", ["arrowright", "d"]],
      ["up", ["arrowup", "w"]],
      ["down", ["arrowdown", "s"]],
      ["brake", ["shift"]],
      ["reverse", ["b"]],
    ]) {
      $(id).setAttribute(
        "aria-pressed",
        String(names.some((key) => keys.has(key))),
      );
    }
  });
}
