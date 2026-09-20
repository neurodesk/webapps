import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { insideMask } from "./mask.js";
import { TunnelCamera, clearSight, lumenExtent, lumenRadius } from "./chase.js";
import { loadHumanData } from "./human-data.js";
import { Flight } from "./flight.js";
import { createRouteArrowGeometry } from "./route-arrow.js";
import { Race, BUMP_PENALTY, TRACKS, bumpPenalty, speedScore, trackFor } from "./race.js";
import { OverviewMap, humanChallenge } from "./navigation-map.js";
import { HeldInputs } from "./held-inputs.js";
import { aimFromOffset } from "./controls.js";
import { Tilt } from "./tilt.js";
import { freeDistance } from "./assist.js";
import { createLeaderboard, formatTime } from "./leaderboard.js";
import { LEADERBOARD_URL } from "./config.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
const coarse = matchMedia("(pointer: coarse)").matches;
if (coarse) document.body.classList.add("is-touch");
let storage;
try {
  storage = window.localStorage;
} catch {
  /* Storage can be disabled. */
}
const leaderboard = createLeaderboard({ url: LEADERBOARD_URL, storage });
const SPEED_KEY = "vessel-surfer.speed.v1";
const TRACK_KEY = "vessel-surfer.track.v1";
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_STEP = 0.25;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: $("ocean"),
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
} catch {
  $("hint").textContent =
    "3D rendering is unavailable. Enable WebGL or try another browser.";
  $("play").textContent = "WebGL unavailable";
}
if (renderer) boot();

function boot() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x071820);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x071820, 0.003);
  const camera = new THREE.PerspectiveCamera(78, 1, 0.002, 600);
  const orbit = new OrbitControls(camera, $("ocean"));
  orbit.enableDamping = true;
  orbit.autoRotate = true;
  orbit.autoRotateSpeed = 0.5;
  orbit.minDistance = 5;
  orbit.maxDistance = 260;
  scene.add(new THREE.HemisphereLight(0xffccc4, 0x33111a, 1.2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-30, 65, 60);
  scene.add(light);
  const fill = new THREE.PointLight(0x34bad5, 1800);
  fill.position.set(30, -30, -20);
  scene.add(fill);
  const vessels = new THREE.Group();
  const beacons = new THREE.Group();
  // Gold arrows along the validated route point the way to the destination.
  const trail = new THREE.Group();
  scene.add(vessels, beacons, trail);
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
    shininess: 65,
  });
  // Vessels outside the playable lumen, shown only in the overview.
  const contextMaterial = new THREE.MeshPhongMaterial({
    color: 0x8c3a50,
    emissive: 0x2a0c16,
    side: THREE.DoubleSide,
    shininess: 30,
  });
  const tunnel = new TunnelCamera();
  const headlamp = new THREE.PointLight(0xffc6ac, 5, 12, 1);
  scene.add(headlamp);
  const beaconGeometry = new THREE.TorusGeometry(0.92, 0.13, 8, 24);
  const beaconMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd166,
    emissive: 0xb57616,
    emissiveIntensity: 2,
  });
  const arrowGeometry = createRouteArrowGeometry();
  const arrowMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc44d,
    emissive: 0xff9a1c,
    emissiveIntensity: 0.9,
    roughness: 0.4,
    side: THREE.DoubleSide,
  });
  // Inside the vessel the distance fades to a deep red so far walls read as
  // vessel rather than as a black void; the overview keeps the ocean navy.
  const OCEAN = 0x071820;
  const DEPTHS = 0x1c0a12;
  let dirty = true;
  orbit.addEventListener("change", () => {
    dirty = true;
  });

  // Game state: loading | ready | running | paused | complete.
  let state = "loading";
  let overview = true;
  let network = null;
  let human = null;
  let humanPromise = null;
  let travel = 0;
  let race = new Race();
  let lastResult = null;
  let target = null;
  let targetRadius = 0.35;
  let routeLength = 0;
  let challenge = null;
  const challenges = new Map();
  let track = trackFor(storage?.getItem(TRACK_KEY)) || TRACKS[0];
  const player = new THREE.Vector3();
  const direction = new THREE.Vector3(0, 1, 0);
  const swimUp = new THREE.Vector3(0, 1, 0);
  const keys = new HeldInputs();
  const flight = new Flight();
  // Desktop steers with the keyboard only. Phones steer by tilting; the drag
  // joystick is the fallback when motion sensors are unavailable or refused.
  const stick = { yaw: 0, pitch: 0, pointer: null, x: 0, y: 0 };
  const tilt = new Tilt();
  // off | requesting | on | unavailable
  let tiltState = "off";
  let tiltTimer = 0;
  let tiltRecentres = 0;
  const overviewMap = new OverviewMap(renderer, scene, $("map"));
  let turnRequest = false;
  let coachUntil = 0;
  let vesselBounds = new THREE.Sphere(new THREE.Vector3(), 60);
  const ocean = $("ocean");
  const running = () => state === "running";

  function showMenu(next) {
    state = next;
    $("menu").hidden = next === "running";
    $("menu").dataset.state = next;
    for (const element of $("menu").querySelectorAll("[data-show]"))
      element.classList.toggle(
        "is-shown",
        element.dataset.show.split(" ").includes(next),
      );
    $("play").textContent = {
      loading: "Loading brain…",
      ready: "Dive",
      running: "Pause",
      paused: "Resume",
      complete: "Race again",
    }[next];
    $("play").disabled = next === "loading";
    $("quick-play").disabled = next === "loading" || next === "ready";
    $("quick-play").textContent = next === "running" ? "Ⅱ" : "▶";
    $("quick-play").setAttribute(
      "aria-label",
      next === "running" ? "Pause" : "Resume",
    );
    $("navigation-map").hidden = !target || next === "ready" || next === "loading";
    $("touch").hidden = next !== "running";
    $("speed-panel").hidden = next !== "running";
    document.body.classList.toggle("is-running", next === "running");
    $("hint").textContent = "";
    dirty = true;
  }

  function renderBoard(board, mine) {
    const rows = $("score-rows");
    rows.replaceChildren();
    if (!board.rows.length) {
      const cell = rows.insertRow().insertCell();
      cell.colSpan = 5;
      cell.textContent = "No completed runs yet. Be the first!";
    }
    board.rows.forEach((result, index) => {
      const row = rows.insertRow();
      if (
        mine &&
        result.name === mine.name &&
        result.points === mine.points &&
        result.bumps === mine.bumps
      )
        row.classList.add("is-you");
      for (const [text, className] of [
        [index + 1, "rank"],
        [result.name, "name"],
        [result.points.toLocaleString(), "points"],
        [formatTime(result.seconds), "time"],
        [result.bumps, "bumps"],
      ]) {
        const cell = row.insertCell();
        cell.textContent = text;
        cell.className = className;
      }
    });
    $("board-title").textContent = `${track.name} leaderboard`;
    $("board-status").textContent =
      board.scope === "global"
        ? `Top ${board.rows.length} worldwide`
        : "Leaderboard offline · best runs on this device";
    $("board-status").title = board.error || "";
  }
  let boardRequest = 0;
  async function refreshBoard(mine) {
    const token = ++boardRequest;
    const board = await leaderboard.top(10, track.challenge);
    if (token === boardRequest) renderBoard(board, mine);
  }
  // Track picker: one button per track, the chosen one remembered.
  const picker = $("tracks");
  function renderTracks() {
    picker.replaceChildren();
    for (const item of TRACKS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "track";
      button.dataset.track = item.challenge;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(item === track));
      const name = document.createElement("strong");
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "track__meta";
      meta.textContent = `${item.length} mm`;
      const blurb = document.createElement("span");
      blurb.className = "track__blurb";
      blurb.textContent = item.blurb;
      button.append(name, meta, blurb);
      button.onclick = () => selectTrack(item);
      picker.append(button);
    }
  }
  function selectTrack(item) {
    if (item === track && state !== "loading") return;
    track = item;
    try {
      storage?.setItem(TRACK_KEY, item.challenge);
    } catch {
      /* Storage can be disabled. */
    }
    for (const button of picker.children)
      button.setAttribute("aria-checked", String(button.dataset.track === item.challenge));
    if (network) reset();
  }
  renderTracks();

  $("map-view").onclick = () => {
    const route = overviewMap.toggle() === "route";
    $("map-view").textContent = route ? "Route · show whole brain" : "Whole brain · zoom to route";
    $("map-view").setAttribute(
      "aria-label",
      `Switch map to the ${route ? "whole brain" : "route"}`,
    );
    // Hand focus back to the game so Space still pauses after the click.
    if (running()) ocean.focus({ preventScroll: true });
    dirty = true;
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
  function volumeOf() {
    return human.volume;
  }
  // Fog, lighting and the far plane follow how roomy the vessel is, smoothed
  // over about half a second. They must not follow the distance to the
  // nearest wall: brushing one wall of a wide trunk would otherwise thicken
  // the fog until every other wall vanished into the dark.
  let viewRadius = 0;
  function updateTunnel(dt, radius, snap = false) {
    const volume = volumeOf();
    const unit = Math.min(...volume.scale);
    const extent = Math.max(unit * 1.5, lumenExtent(volume, player));
    viewRadius = snap || !viewRadius ? extent : viewRadius + (extent - viewRadius) * (1 - Math.exp(-dt * 2));
    const ahead = player
      .clone()
      .addScaledVector(direction, Math.max(unit * 0.1, radius * 0.5));
    for (let d = radius * 3; d > unit * 0.001; d *= 0.65) {
      const candidate = player.clone().addScaledVector(direction, d);
      if (clearSight(volume, player, candidate)) {
        ahead.copy(candidate);
        break;
      }
    }
    if (!clearSight(volume, player, ahead))
      ahead.copy(player).addScaledVector(direction, unit * 0.005);
    tunnel.up.copy(swimUp);
    tunnel.update(player, ahead, volume, dt, snap);
    camera.position.copy(tunnel.position);
    camera.up.copy(tunnel.up);
    camera.lookAt(tunnel.target);
    // The eye may sit a few hundredths of a millimetre from a wall, and the
    // corners of the near plane reach further than its centre. A very close
    // near plane keeps the wall from being clipped, which otherwise opens a
    // dark window onto the fogged outside. The far plane sits well inside the
    // fog so long vessels fade instead of ending at a hard edge.
    camera.near = Math.max(0.0003, radius * 0.003);
    camera.far = Math.max(4, viewRadius * 40);
    camera.updateProjectionMatrix();
    const distance = Math.min(radius * 1.3, player.distanceTo(ahead) * 0.7);
    const subPoint = player
      .clone()
      .addScaledVector(tunnel.heading, distance)
      .addScaledVector(tunnel.up, -radius * 0.22);
    sub.visible =
      distance > unit * 0.04 && clearSight(volume, player, subPoint);
    sub.position.copy(subPoint);
    sub.scale.setScalar(Math.min(radius * 0.1, distance * 0.12));
    headlamp.position
      .copy(player)
      .addScaledVector(tunnel.heading, Math.min(radius * 0.1, distance * 0.1));
    headlamp.intensity = viewRadius * 9;
    headlamp.distance = Math.max(unit * 6, viewRadius * 15);
    scene.fog.density = 0.09 / viewRadius;
    $("ocean").dataset.fogDensity = scene.fog.density.toFixed(3);
    const data = $("ocean").dataset;
    data.cameraInside = String(insideMask(volume, camera.position.toArray()));
    data.cameraPosition = JSON.stringify(camera.position.toArray());
    data.cameraTarget = JSON.stringify(tunnel.target.toArray());
    data.clearView = String(clearSight(volume, camera.position, tunnel.target));
  }
  // On wide screens the menu panel sits centred, so shift the overview's
  // projection to keep the vasculature visible beside it.
  // On wide screens the menu panel sits centred, so the overview is centred in
  // the free strip to its left and pushed back far enough to fit there whole.
  function overviewStrip() {
    const width = ocean.clientWidth;
    const panel = Math.min(440, width - 24);
    const free = (width - panel) / 2;
    return { width, free, wide: width > 900 };
  }
  function frameOverview() {
    const { width, free, wide } = overviewStrip();
    const height = ocean.clientHeight;
    if (overview && wide)
      camera.setViewOffset(width, height, width / 2 - free / 2, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  function overviewDistance(radius) {
    const { width, free, wide } = overviewStrip();
    const height = ocean.clientHeight;
    const visible = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const fit = (ratio) => (2 * radius) / (visible * ratio);
    const byHeight = fit(0.8 * (height / width) * (width / height));
    const byWidth = fit((0.85 * (wide ? free : width)) / height);
    return Math.max(radius * 2.4, byHeight, byWidth);
  }
  function setView(value) {
    dirty = true;
    overview = value;
    frameOverview();
    headlamp.visible = !value;
    scene.fog.density = value ? 0.003 : 0.12;
    scene.fog.color.set(value ? OCEAN : DEPTHS);
    renderer.setClearColor(value ? OCEAN : DEPTHS);
    orbit.enabled = value;
    for (const child of vessels.children) {
      if (child.name === "overview-surface") child.visible = value;
      if (child.name === "tunnel-surface") child.visible = !value;
    }
    if (value) {
      // Frame whatever vasculature is loaded, whichever resolution it has.
      const sphere = vesselBounds;
      camera.far = Math.max(600, sphere.radius * 12);
      camera.updateProjectionMatrix();
      camera.up.set(0, 1, 0);
      camera.position
        .set(0.55, 0.4, 0.75)
        .normalize()
        .multiplyScalar(overviewDistance(sphere.radius))
        .add(sphere.center);
      orbit.target.copy(sphere.center);
      orbit.minDistance = sphere.radius * 0.2;
      orbit.maxDistance = sphere.radius * 6;
      orbit.update();
      sub.visible = true;
      sub.position.copy(player);
      sub.scale.setScalar(0.5);
    } else {
      updateTunnel(0, lumenRadius(volumeOf(), player), true);
    }
  }
  function measureVessels() {
    const bounds = new THREE.Box3().setFromObject(vessels);
    vesselBounds = bounds.isEmpty()
      ? new THREE.Sphere(new THREE.Vector3(), 60)
      : bounds.getBoundingSphere(new THREE.Sphere());
  }
  function reset() {
    const volume = volumeOf();
    const unit = Math.min(...volume.scale);
    measureVessels();
    race = new Race(Math.min(...volume.scale) * 0.4, track.challenge);
    lastResult = null;
    travel = 0;
    keys.clear();
    flight.reset();
    stick.yaw = stick.pitch = 0;
    turnRequest = false;
    swimUp.set(0, 1, 0);
    clear(beacons);
    clear(trail);
    if (!challenges.has(track.challenge))
      challenges.set(track.challenge, humanChallenge(network, volume, track));
    challenge = challenges.get(track.challenge);
    // Spawn on the route, facing along it: the route may leave the launch
    // point against the edge's stored direction.
    player.copy(challenge.path[0]);
    direction.copy(challenge.path[1]).sub(challenge.path[0]).normalize();
    target = challenge.target.clone();
    targetRadius = 0.35;
    const beacon = new THREE.Mesh(beaconGeometry, beaconMaterial);
    beacon.position.copy(target);
    beacon.scale.setScalar(targetRadius * 0.7);
    beacons.add(beacon);
    const path = challenge.path;
    routeLength = challenge.length;
    overviewMap.configure({
      bounds: vesselBounds,
      start: player,
      target,
      path,
      minSpan: 18,
    });
    if (path.length > 1) {
      // One arrow per validated route sample (0.25 mm apart), laid on the
      // vessel wall on the "floor" side of the route and pointing along it,
      // so the way to go is readable at a glance and never in the eye's way.
      const arrows = new THREE.InstancedMesh(arrowGeometry, arrowMaterial, path.length);
      arrows.userData.sharedAsset = true;
      const matrix = new THREE.Matrix4();
      const worldDown = new THREE.Vector3(0, -1, 0);
      arrows.userData.points = path.map((p, i) => {
        const forward = challenge.directions[i].clone();
        // Sized to the local lumen so arrows read alike in wide and narrow branches.
        const size = THREE.MathUtils.clamp(lumenRadius(volume, p) * 0.6, unit * 0.6, unit * 2.4);
        // The floor side: world-down made perpendicular to the route; in a
        // near-vertical vessel use the sideways direction instead.
        let down = worldDown.clone().addScaledVector(forward, -worldDown.dot(forward));
        if (down.lengthSq() < 0.05) down = new THREE.Vector3(1, 0, 0).cross(forward);
        down.normalize();
        const floor = freeDistance(volume, p, down, unit * 8);
        const spot = p.clone().addScaledVector(down, Math.max(0, floor - unit * 0.35));
        const normal = down.clone().negate();
        const right = normal.clone().cross(forward).normalize();
        matrix.makeBasis(right, normal, forward).scale(new THREE.Vector3(size, size, size)).setPosition(spot);
        arrows.setMatrixAt(i, matrix);
        return { spot, size, right, normal, forward };
      });
      arrows.instanceMatrix.needsUpdate = true;
      trail.add(arrows);
    }
    // The validated reference route, for browser verification only.
    $("ocean").dataset.path = JSON.stringify(
      path.map((p) => p.toArray().map((v) => Number(v.toFixed(3)))),
    );
    $("mission-text").textContent = `Pilot a tiny submarine through real human brain vessels. ${track.name}: follow the gold arrows ${Math.round(routeLength)} mm to the gold ring.`;
    $("run-breakdown").replaceChildren();
    swimUp.addScaledVector(direction, -swimUp.dot(direction)).normalize();
    sub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    $("score").textContent = "0:00.0";
    $("bumps").textContent = "0 bumps";
    $("submit-status").textContent =
      "Only your name, time and bump count are sent to the Neurodesk leaderboard server.";
    $("submit").disabled = false;
    setView(true);
    showMenu("ready");
    refreshBoard();
  }
  function start() {
    if (state === "loading" || !network) return;
    if (state === "complete") reset();
    if (overview) setView(false);
    race.resume(performance.now());
    showMenu("running");
    coachUntil = performance.now() + 6000;
    if (coarse) enableTilt();
    $("hint").textContent = coach();
    $("ocean").focus({ preventScroll: true });
  }
  const steerHint = () =>
    coarse
      ? tiltState === "unavailable"
        ? "Drag anywhere to steer · Turn flips around · hold Stop or Back"
        : "Tilt the phone to steer · tap to recentre · Turn flips around · hold Stop or Back"
      : "Arrow keys or WASD steer, or click and drag · +/− sets speed · R turns around · Shift brakes · Space pauses";
  // Motion steering starts from a user gesture (the Dive tap) because iOS
  // only grants orientation events after DeviceOrientationEvent.requestPermission.
  // Without a sensor sample soon after, the drag joystick takes over.
  function onOrientation(event) {
    if (tiltState === "unavailable") return;
    if (tiltState !== "on") {
      tiltState = "on";
      clearTimeout(tiltTimer);
    }
    tilt.update(event, screen.orientation?.angle ?? window.orientation ?? 0);
  }
  async function enableTilt() {
    if (tiltState === "on" || tiltState === "unavailable") {
      tilt.reset();
      return;
    }
    tiltState = "requesting";
    tilt.reset();
    try {
      if (typeof DeviceOrientationEvent?.requestPermission === "function") {
        const answer = await DeviceOrientationEvent.requestPermission();
        if (answer !== "granted") throw new Error("Motion access refused.");
      }
      if (typeof DeviceOrientationEvent === "undefined")
        throw new Error("No motion sensors.");
    } catch {
      tiltState = "unavailable";
      $("hint").textContent = coach();
      return;
    }
    window.addEventListener("deviceorientation", onOrientation);
    clearTimeout(tiltTimer);
    tiltTimer = setTimeout(() => {
      if (tiltState === "requesting") {
        tiltState = "unavailable";
        window.removeEventListener("deviceorientation", onOrientation);
        if (running()) $("hint").textContent = coach();
      }
    }, 1500);
  }
  function coach() {
    const distance = target ? player.distanceTo(target) : 0;
    return `${track.name} · follow the gold arrows to the ring, ${distance.toFixed(1)} mm ahead · faster earns more, bumps cost ${BUMP_PENALTY} · ${steerHint()}`;
  }
  function pause() {
    if (!running()) return;
    race.pause(performance.now());
    keys.clear();
    flight.reset();
    turnRequest = false;
    stick.yaw = stick.pitch = 0;
    stick.pointer = null;
    $("stick").hidden = true;
    tilt.reset();
    showMenu("paused");
  }
  function finish() {
    lastResult = race.finish(performance.now());
    keys.clear();
    flight.reset();
    const message = `${lastResult.points.toLocaleString()} points · ${formatTime(lastResult.seconds)} · ${lastResult.bumps} wall bumps`;
    $("run-result").textContent = message;
    const breakdown = $("run-breakdown");
    breakdown.replaceChildren();
    const average = routeLength / Math.max(lastResult.seconds, 0.001);
    const rows = [
      ["Speed score", `+${speedScore(lastResult.seconds, track.challenge).toLocaleString()}`, `${track.name} · ${routeLength.toFixed(1)} mm in ${formatTime(lastResult.seconds)} · ${average.toFixed(2)} mm/s · ${track.speedPoints.toLocaleString()} ÷ seconds`, "plus"],
      ["Wall penalty", `−${bumpPenalty(lastResult.bumps).toLocaleString()}`, `${lastResult.bumps} bump${lastResult.bumps === 1 ? "" : "s"} × ${BUMP_PENALTY}`, "minus"],
      ["Points", lastResult.points.toLocaleString(), "speed score minus wall penalty", "total"],
    ];
    for (const [label, value, note, kind] of rows) {
      const row = document.createElement("div");
      row.className = `breakdown__row is-${kind}`;
      const name = document.createElement("span");
      name.className = "breakdown__label";
      name.textContent = label;
      const amount = document.createElement("strong");
      amount.className = "breakdown__value";
      amount.textContent = value;
      const detail = document.createElement("span");
      detail.className = "breakdown__note";
      detail.textContent = note;
      row.append(name, amount, detail);
      breakdown.append(row);
    }
    showMenu("complete");
    $("submit-form").hidden = false;
    $("player-name").value = leaderboard.name;
    $("player-name").focus({ preventScroll: true });
    refreshBoard();
  }
  $("submit-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!lastResult) return;
    const result = lastResult;
    const name = $("player-name").value;
    // An earlier GET must not replace the freshly saved leaderboard.
    boardRequest++;
    $("submit").disabled = true;
    $("submit-status").textContent = "Saving…";
    try {
      const outcome = await leaderboard.submit(result, name);
      if (lastResult !== result || state !== "complete") return;
      const mine = { ...result, name: leaderboard.name };
      renderBoard(outcome, mine);
      $("submit-status").textContent = outcome.scope === "global"
        ? `Saved. You are #${outcome.rank.toLocaleString()} in the world.`
        : `Could not save online (${outcome.error}). ${outcome.savedLocally ? "Saved on this device." : "Could not save on this device."} Press Save score to retry.`;
      $("submit").disabled = outcome.scope === "global";
    } catch (error) {
      if (lastResult !== result || state !== "complete") return;
      $("submit-status").textContent = `Could not save this run: ${error.message}`;
      $("submit").disabled = false;
    }
  };
  // Switch the scene between its tunnel appearance and the overview drawn in
  // the map window: whole surface instead of culled chunks, no fog, no
  // headlamp, no trail or beacon (the map has its own markers).
  let subShown = true;
  let fogDensity = 0.12;
  function mapPass(on) {
    for (const child of vessels.children) {
      if (child.name === "overview-surface") child.visible = on || overview;
      if (child.name === "tunnel-surface") child.visible = !on && !overview;
    }
    if (on) {
      subShown = sub.visible;
      fogDensity = scene.fog.density;
    }
    sub.visible = on ? false : subShown;
    scene.fog.density = on ? 0 : fogDensity;
    trail.visible = !on;
    beacons.visible = !on;
    headlamp.visible = !on && !overview;
  }
  // Arrows right under the eye would fill the view, so each one shrinks away
  // as the sub passes over it and grows back once it is behind.
  const arrowMatrix = new THREE.Matrix4();
  const arrowScale = new THREE.Vector3();
  function fadeTrail() {
    const unit = Math.min(...volumeOf().scale);
    for (const arrows of trail.children) {
      arrows.userData.points.forEach(({ spot, size, right, normal, forward }, i) => {
        const t = THREE.MathUtils.smoothstep(
          player.distanceTo(spot),
          unit * 2.5,
          unit * 5,
        );
        arrowScale.setScalar(Math.max(1e-4, size * t));
        arrowMatrix.makeBasis(right, normal, forward).scale(arrowScale).setPosition(spot);
        arrows.setMatrixAt(i, arrowMatrix);
      });
      arrows.instanceMatrix.needsUpdate = true;
    }
  }
  async function loadDemo() {
    showMenu("loading");
    $("hint").textContent = "Loading the human brain vessel segmentation…";
    try {
      humanPromise ||= loadHumanData().catch((error) => {
        humanPromise = null;
        throw error;
      });
      const data = await humanPromise;
      human = data;
      network = human.network;
      challenge = null;
      challenges.clear();
      clear(vessels);
      const overviewMesh = new THREE.Mesh(human.geometry, vesselMaterial);
      overviewMesh.name = "overview-surface";
      overviewMesh.userData.sharedAsset = true;
      if (human.context) {
        const contextMesh = new THREE.Mesh(human.context, contextMaterial);
        contextMesh.name = "overview-surface";
        contextMesh.userData.sharedAsset = true;
        vessels.add(contextMesh);
      }
      const detail = new THREE.Group();
      detail.name = "tunnel-surface";
      for (const geometry of human.chunks) {
        const mesh = new THREE.Mesh(geometry, vesselMaterial);
        mesh.userData.sharedAsset = true;
        detail.add(mesh);
      }
      vessels.add(overviewMesh, detail);
      $("source-label").firstChild.textContent =
        "Human pial arteries · 7T TOF at 140 µm · Bollmann et al. 2022 · ";
      reset();
    } catch (error) {
      showMenu("ready");
      $("play").disabled = false;
      $("play").textContent = "Retry loading brain";
      $("mission-text").textContent = `Could not load brain data: ${error.message}`;
    }
  }
  $("play").onclick = () => {
    if (state === "ready" && !network) loadDemo();
    else if (state === "running") pause();
    else start();
  };
  $("quick-play").onclick = $("play").onclick;
  $("reset").onclick = () => {
    if (state === "loading" || !network) return;
    reset();
    start();
  };
  $("menu-button").onclick = () => {
    if (state === "loading" || !network) return;
    reset();
  };
  // One cruising speed, shown on the menu slider and the in-run slider, and
  // adjustable mid-run from the keyboard.
  const speedInputs = [$("speed"), $("speed-hud")];
  function setSpeed(value, announce = false) {
    const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value / SPEED_STEP) * SPEED_STEP));
    for (const input of speedInputs) input.value = String(clamped);
    for (const id of ["speed-value", "speed-hud-value"]) $(id).textContent = `${clamped}×`;
    try {
      storage?.setItem(SPEED_KEY, String(clamped));
    } catch {
      /* Storage can be full or disabled. */
    }
    if (announce && running()) $("hint").textContent = `Speed ${clamped}× · faster earns more points, bumps cost ${BUMP_PENALTY}`;
    return clamped;
  }
  const cruise = () => Number($("speed").value);
  const savedSpeed = Number(storage?.getItem(SPEED_KEY));
  setSpeed(savedSpeed >= SPEED_MIN && savedSpeed <= SPEED_MAX ? savedSpeed : 0.5);
  for (const input of speedInputs)
    input.oninput = () => setSpeed(Number(input.value));
  $("speed-hud").onchange = () => {
    if (running()) ocean.focus({ preventScroll: true });
  };
  $("turn").onpointerdown = (e) => {
    e.preventDefault();
    turnRequest = true;
  };
  $("turn").onkeydown = (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (!e.repeat) turnRequest = true;
  };
  for (const [id, key] of [
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
      if (!e.repeat) keys.press(`button:${id}:${e.key}`, key);
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
  }
  const flightKeys = [
    "arrowleft",
    "arrowright",
    "arrowup",
    "arrowdown",
    "a",
    "d",
    "w",
    "s",
    "shift",
    "b",
  ];
  window.addEventListener("keydown", (e) => {
    if (
      e.defaultPrevented ||
      e.target.closest("input,select,textarea,summary,[contenteditable=true]")
    )
      return;
    if (e.target.closest("button") && (e.key === " " || e.key === "Enter"))
      return;
    const k = e.key.toLowerCase();
    if (k === "escape" && !e.repeat) {
      if (running()) pause();
      else if (state === "paused") start();
      return;
    }
    if (k === " ") {
      e.preventDefault();
      if (!e.repeat && state !== "loading") {
        if (running()) pause();
        else start();
      }
      return;
    }
    if (k === "r") {
      e.preventDefault();
      if (!e.repeat && running()) turnRequest = true;
      return;
    }
    if (["+", "=", "-", "_", "]", "["].includes(k)) {
      if (!running()) return;
      e.preventDefault();
      const faster = k === "+" || k === "=" || k === "]";
      setSpeed(cruise() + (faster ? SPEED_STEP : -SPEED_STEP), true);
      return;
    }
    if (flightKeys.includes(k)) {
      e.preventDefault();
      keys.press(`keyboard:${k}`, k);
    }
  });
  window.addEventListener("keyup", (e) =>
    keys.release(`keyboard:${e.key.toLowerCase()}`),
  );
  window.addEventListener("blur", pause);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  // A floating joystick anchored where a drag began: the mouse on a computer
  // (only while the button is held, so a resting pointer never steers and is
  // free to reach the controls) and touch on a phone without motion sensors.
  // With tilt steering, a tap on the canvas recentres the neutral pose.
  const stickRadius = 56;
  ocean.addEventListener("pointermove", (e) => {
    if (!running() || overview || stick.pointer !== e.pointerId) return;
    const dx = e.clientX - stick.x;
    const dy = e.clientY - stick.y;
    const scale = Math.min(1, stickRadius / (Math.hypot(dx, dy) || 1));
    Object.assign(stick, aimFromOffset(dx, dy, stickRadius, 0.1));
    $("stick").firstElementChild.style.transform =
      `translate(${dx * scale}px, ${dy * scale}px)`;
  });
  ocean.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") document.body.classList.add("is-touch");
    if (!running() || overview || stick.pointer !== null) return;
    e.preventDefault();
    ocean.focus({ preventScroll: true });
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (tiltState === "on") {
      tilt.reset();
      tiltRecentres++;
      coachUntil = 0;
      $("hint").textContent = "Tilt recentred · hold the phone still here to fly straight";
      return;
    }
    ocean.setPointerCapture(e.pointerId);
    stick.pointer = e.pointerId;
    stick.x = e.clientX;
    stick.y = e.clientY;
    stick.yaw = stick.pitch = 0;
    $("stick").style.left = `${e.clientX}px`;
    $("stick").style.top = `${e.clientY}px`;
    $("stick").firstElementChild.style.transform = "";
    $("stick").hidden = false;
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    ocean.addEventListener(event, (e) => {
      if (stick.pointer !== e.pointerId) return;
      stick.pointer = null;
      stick.yaw = stick.pitch = 0;
      $("stick").hidden = true;
    });
  function resize() {
    dirty = true;
    const width = ocean.clientWidth;
    const height = ocean.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    frameOverview();
  }
  new ResizeObserver(resize).observe(ocean);
  ocean.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    pause();
    $("play").disabled = true;
    $("hint").textContent =
      "Graphics connection lost. Reload the page to restart.";
  });
  loadDemo();
  resize();
  let last = 0;
  let frames = 0;
  renderer.setAnimationLoop((time) => {
    const dt = Math.min((time - last) / 1000, 0.08);
    last = time;
    if (running()) {
      race.tick(performance.now());
      const volume = volumeOf();
      const braking = keys.has("shift");
      const reversing = keys.has("b");
      const playerDemand = {
        yaw:
          (keys.has("arrowright") || keys.has("d") ? 1 : 0) -
          (keys.has("arrowleft") || keys.has("a") ? 1 : 0) +
          tilt.yaw +
          stick.yaw,
        pitch:
          (keys.has("arrowup") || keys.has("w") ? 1 : 0) -
          (keys.has("arrowdown") || keys.has("s") ? 1 : 0) +
          tilt.pitch +
          stick.pitch,
      };
      const { moved, speed, radius, turning, blocked } = flight.step(
        volume, player, direction, swimUp,
        { dt, cruise: cruise(), braking, reversing, playerDemand, turnRequest },
      );
      turnRequest = false;
      race.movement(Math.abs(dt * speed), moved);
      travel += moved;
      if (frames % 10 === 0)
        $("hint").textContent = turning
          ? "Turning around…"
          : braking
            ? "Braking · steer, release to go"
            : blocked
              ? "Wall · steer away, press R or Turn to turn around, or hold Back"
              : performance.now() < coachUntil
                ? coach()
                : steerHint();
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
      )
        finish();
      else updateTunnel(dt, radius);
      if (frames % 3 === 0) fadeTrail();
      dirty = true;
    } else if (overview) {
      orbit.update();
      sub.position.copy(player);
    }
    $("score").textContent = formatTime(race.seconds);
    $("bumps").textContent = `${race.bumps} bump${race.bumps === 1 ? "" : "s"}`;
    if (target && !$("navigation-map").hidden) {
      $("target-distance").textContent =
        `${player.distanceTo(target).toFixed(1)} mm away · ${Math.abs(target.y - player.y).toFixed(1)} ${target.y >= player.y ? "above" : "below"}`;
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
    if (dirty) {
      renderer.render(scene, camera);
      if (target && !overview && !$("navigation-map").hidden)
        overviewMap.render(player, direction, dt, ocean, mapPass);
      dirty = false;
    }
    frames++;
    // Read-only telemetry for accessible integrations and browser verification.
    const data = ocean.dataset;
    data.state = state;
    data.distance = travel.toFixed(2);
    data.source = human ? "human-pial-arteries" : "loading";
    data.position = JSON.stringify(player.toArray());
    data.heading = JSON.stringify(direction.toArray());
    data.up = JSON.stringify(swimUp.toArray());
    data.elapsed = race.seconds.toFixed(3);
    data.bumps = String(race.bumps);
    data.target = target ? JSON.stringify(target.toArray()) : "";
    data.held = [...keys].join(",");
    data.turning = String(flight.uturn.active);
    data.blocked = String(flight.blocked);
    data.tilt = tiltState;
    data.track = track.challenge;
    data.tiltRecentres = String(tiltRecentres);
    data.mapZoom = overviewMap.zoom;
    for (const [id, names] of [
      ["brake", ["shift"]],
      ["reverse", ["b"]],
    ])
      $(id).setAttribute(
        "aria-pressed",
        String(names.some((key) => keys.has(key))),
      );
  });
}
