<script lang="ts">
import type { MeshData } from "@shared/types";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const { mesh }: { mesh: MeshData } = $props();

let canvas: HTMLCanvasElement | null = $state(null);
let host: HTMLDivElement | null = $state(null);
let error = $state<string | null>(null);

$effect(() => {
  const element = canvas;
  const container = host;
  const positions = mesh.positions;

  if (!element || !container) return;
  if (positions.length < 9 || positions.some((value) => !Number.isFinite(value))) {
    error = "This preview does not contain renderable geometry.";
    return;
  }
  error = null;

  const width = container.clientWidth || 320;
  const height = container.clientHeight || 320;

  const renderer = new THREE.WebGLRenderer({ canvas: element, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1e7);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: 0x9aa4b2,
    metalness: 0.15,
    roughness: 0.72,
    side: THREE.DoubleSide,
  });
  const model = new THREE.Mesh(geometry, material);
  scene.add(model);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.1));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
  keyLight.position.set(1, 1.6, 1.2);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.55);
  fillLight.position.set(-1.4, -0.7, -1.1);
  scene.add(fillLight);

  const sphere = geometry.boundingSphere;
  const center = sphere ? sphere.center.clone() : new THREE.Vector3(0, 0, 0);
  const radius = sphere && sphere.radius > 0 ? sphere.radius : 1;
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.75, distance));
  camera.near = Math.max(radius / 1000, 0.001);
  camera.far = distance + radius * 20;
  camera.updateProjectionMatrix();

  const controls = new OrbitControls(camera, element);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  let frame = requestAnimationFrame(function render() {
    controls.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  });

  const resize = (): void => {
    const nextWidth = container.clientWidth || width;
    const nextHeight = container.clientHeight || height;
    renderer.setSize(nextWidth, nextHeight, false);
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    controls.dispose();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  };
});
</script>

<div class="preview-stage" bind:this={host}>
  <canvas bind:this={canvas} aria-label="3D model preview"></canvas>
  {#if error}
    <p class="empty">{error}</p>
  {/if}
</div>
