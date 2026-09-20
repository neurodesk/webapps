import * as THREE from "three";
import { lumenRadius } from "./chase.js";
import { TRACKS } from "./race.js";

// A track's route: the longest simple path through the route graph from its
// start, using only branches whose lumen stays at least `floor` millimetres
// wide. The graph is a forest, so the search is a plain depth-first walk.
// Starts are either the launch point on the widest trunk (with the longest or
// the shortest of its two directions) or a leaf node. The route is sampled
// every `spacing` millimetres for the trail and the map; the destination is
// its last point.
export function humanChallenge(network, volume, track = TRACKS[0], spacing = 0.25) {
  const floor = track.floor;
  const minRadius = new Map();
  for (const edge of network.edges) {
    let radius = Infinity;
    const steps = Math.max(2, Math.ceil(edge.length / 0.5));
    for (let i = 0; i <= steps; i++)
      radius = Math.min(radius, lumenRadius(volume, edge.curve.getPointAt(i / steps)));
    minRadius.set(edge.id, radius);
  }
  const visited = new Set();
  const longest = (node, from) => {
    let best = { length: 0, edges: [] };
    for (const edge of network.adjacency[node]) {
      if (edge.id === from || visited.has(edge.id) || minRadius.get(edge.id) < floor) continue;
      visited.add(edge.id);
      const branch = longest(edge.a === node ? edge.b : edge.a, edge.id);
      visited.delete(edge.id);
      if (branch.length + edge.length > best.length)
        best = { length: branch.length + edge.length, edges: [edge.id, ...branch.edges] };
    }
    return best;
  };
  const path = [];
  const sample = (edge, fromT, toT) => {
    const count = Math.max(1, Math.round((Math.abs(toT - fromT) * edge.length) / spacing));
    for (let i = path.length ? 1 : 0; i <= count; i++)
      path.push(edge.curve.getPointAt(fromT + ((toT - fromT) * i) / count));
  };
  let node, edges, length;
  if (track.start.edge === "launch") {
    const start = network.edges[network.start.edge];
    visited.add(start.id);
    const candidates = [false, true].map((reverse) => {
      const first = (reverse ? network.start.progress : 1 - network.start.progress) * start.length;
      const rest = longest(reverse ? start.a : start.b, start.id);
      return { reverse, length: first + rest.length, edges: rest.edges };
    });
    candidates.sort((a, b) => b.length - a.length);
    const choice = track.start.direction === "shortest" ? candidates[1] : candidates[0];
    sample(start, network.start.progress, choice.reverse ? 0 : 1);
    node = choice.reverse ? start.a : start.b;
    ({ edges, length } = choice);
  } else {
    node = track.start.node;
    ({ edges, length } = longest(node, -1));
    if (!edges.length) throw new Error(`Track ${track.challenge} has no route.`);
  }
  let remainingInset = path.length ? 0 : track.start.inset ?? 0;
  for (const id of edges) {
    const edge = network.edges[id];
    const forward = edge.a === node;
    // Leaf tips can begin with a tight bend. A track may launch further along
    // the route, with the map, arrows and measured race sharing that start.
    const inset = Math.min(remainingInset, edge.length);
    remainingInset -= inset;
    const from = forward ? inset / edge.length : 1 - inset / edge.length;
    if (inset < edge.length) sample(edge, from, forward ? 1 : 0);
    length -= inset;
    node = forward ? edge.b : edge.a;
  }
  // The trail arrows need a direction at every sample.
  const directions = path.map((p, i) =>
    (i + 1 < path.length ? path[i + 1].clone().sub(p) : p.clone().sub(path[i - 1])).normalize(),
  );
  return { track, target: path.at(-1).clone(), path, directions, length };
}

// A live 3D overview drawn by the game renderer into a corner of the main
// canvas: the real vessel surface with the validated route, the start, the
// destination and the player's heading on top. "Route" framing follows the
// player heading-up like a car navigator; "Brain" framing shows the whole
// vasculature from a fixed angle.
export class OverviewMap {
  constructor(renderer, scene, window) {
    this.renderer = renderer;
    this.scene = scene;
    this.window = window;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 4000);
    this.zoom = "brain";
    this.background = new THREE.Color(0x08161f);
    this.forward = new THREE.Vector3(0, 0, 1);
    this.centre = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.bounds = new THREE.Sphere(new THREE.Vector3(), 60);
    this.minSpan = 18;
    this.markers = new THREE.Group();
    this.markers.name = "map-markers";
    this.markers.visible = false;
    const marker = (geometry, color) =>
      new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
    const cone = new THREE.ConeGeometry(0.5, 1.5, 12);
    cone.rotateX(Math.PI / 2);
    this.player = marker(cone, 0x75f6ef);
    this.destination = marker(new THREE.SphereGeometry(0.55, 14, 10), 0xffd166);
    this.origin = marker(new THREE.SphereGeometry(0.32, 10, 8), 0xd6eff0);
    this.route = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xf4c768, depthTest: false }),
    );
    for (const item of [this.route, this.origin, this.destination, this.player]) {
      item.renderOrder = 10;
      this.markers.add(item);
    }
    scene.add(this.markers);
  }
  configure({ bounds, start, target, path, minSpan }) {
    this.bounds.copy(bounds);
    this.start = start.clone();
    this.target = target.clone();
    this.minSpan = minSpan;
    this.origin.position.copy(start);
    this.destination.position.copy(target);
    this.route.geometry.dispose();
    this.route.geometry = new THREE.BufferGeometry().setFromPoints(
      path.length > 1 ? path : [start, target],
    );
    this.route.visible = path.length > 1;
    this.centre.copy(start).lerp(target, 0.5);
    this.forward.set(0, 0, 1);
    this.settled = false;
  }
  toggle() {
    this.zoom = this.zoom === "route" ? "brain" : "route";
    this.settled = false;
    return this.zoom;
  }
  // Frame the view for this frame. Route framing eases so the map does not
  // jump when the heading swings through a turn.
  frame(player, heading, dt) {
    const blend = this.settled ? 1 - Math.exp(-dt * 4) : 1;
    this.settled = true;
    const up = new THREE.Vector3(0, 1, 0);
    let span;
    if (this.zoom === "brain") {
      span = this.bounds.radius * 2;
      this.look.lerp(this.bounds.center, blend);
      this.eye.lerp(
        new THREE.Vector3(0.55, 0.75, 0.6)
          .normalize()
          .multiplyScalar(this.bounds.radius * 1.8)
          .add(this.bounds.center),
        blend,
      );
    } else {
      const level = heading.clone();
      level.y = 0;
      if (level.lengthSq() > 0.05)
        this.forward.lerp(level.normalize(), blend).normalize();
      span = Math.max(this.minSpan, player.distanceTo(this.target) * 1.7);
      const centre = player.clone().lerp(this.target, 0.5);
      this.centre.lerp(centre, blend);
      this.look.copy(this.centre);
      this.eye.lerp(
        this.centre
          .clone()
          .addScaledVector(this.forward, -span * 0.75)
          .addScaledVector(up, span * 0.85),
        blend,
      );
    }
    this.camera.position.copy(this.eye);
    this.camera.up.copy(up);
    this.camera.lookAt(this.look);
    this.camera.near = Math.max(0.05, span * 0.02);
    this.camera.far = Math.max(50, span * 12);
    const size = span * 0.045;
    this.player.position.copy(player);
    this.player.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), heading);
    this.player.scale.setScalar(size);
    this.destination.scale.setScalar(size);
    this.origin.scale.setScalar(size);
    return span;
  }
  // Draw into the map window. `pass(true)` switches the scene to its overview
  // appearance (full surface, no fog) and `pass(false)` restores it.
  render(player, heading, dt, canvas, pass) {
    const rect = this.window.getBoundingClientRect();
    const host = canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    this.frame(player, heading, dt);
    const renderer = this.renderer;
    const x = rect.left - host.left;
    const y = host.bottom - rect.bottom;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    const clearColor = renderer.getClearColor(new THREE.Color());
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setViewport(x, y, rect.width, rect.height);
    renderer.setClearColor(this.background);
    pass(true);
    this.markers.visible = true;
    renderer.render(this.scene, this.camera);
    this.markers.visible = false;
    pass(false);
    renderer.setClearColor(clearColor);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
  }
}
