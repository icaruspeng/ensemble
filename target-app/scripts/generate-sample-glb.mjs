import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, "../src/assets/roomboard-gem.glb");

const palette = [
  [1, 0.73, 0.18, 1],
  [0.98, 0.43, 0.31, 1],
  [0.27, 0.68, 0.64, 1],
  [0.43, 0.39, 0.84, 1],
];

const top = [0, 1.15, 0];
const bottom = [0, -1.15, 0];
const ring = Array.from({ length: 8 }, (_, index) => {
  const angle = (index / 8) * Math.PI * 2;
  const y = index % 2 === 0 ? 0.1 : -0.1;
  return [Math.cos(angle) * 0.95, y, Math.sin(angle) * 0.95];
});

const subtract = (a, b) => a.map((value, index) => value - b[index]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (vector) => {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
};

const positions = [];
const normals = [];
const colors = [];

function addFace(vertices, color) {
  const normal = normalize(
    cross(subtract(vertices[1], vertices[0]), subtract(vertices[2], vertices[0])),
  );

  vertices.forEach((vertex) => {
    positions.push(...vertex);
    normals.push(...normal);
    colors.push(...color);
  });
}

ring.forEach((point, index) => {
  const next = ring[(index + 1) % ring.length];
  addFace([top, next, point], palette[index % palette.length]);
  addFace([bottom, point, next], palette[(index + 2) % palette.length]);
});

const positionBytes = Buffer.from(new Float32Array(positions).buffer);
const normalBytes = Buffer.from(new Float32Array(normals).buffer);
const colorBytes = Buffer.from(new Float32Array(colors).buffer);
const binaryChunk = Buffer.concat([positionBytes, normalBytes, colorBytes]);

const gltf = {
  asset: { version: "2.0", generator: "Roomboard sample model generator" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [
    {
      name: "Roomboard gem",
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
          material: 0,
        },
      ],
    },
  ],
  materials: [
    {
      name: "Warm facets",
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0.08,
        roughnessFactor: 0.52,
      },
    },
  ],
  buffers: [{ byteLength: binaryChunk.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
    {
      buffer: 0,
      byteOffset: positionBytes.length,
      byteLength: normalBytes.length,
      target: 34962,
    },
    {
      buffer: 0,
      byteOffset: positionBytes.length + normalBytes.length,
      byteLength: colorBytes.length,
      target: 34962,
    },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      min: [-0.95, -1.15, -0.95],
      max: [0.95, 1.15, 0.95],
    },
    {
      bufferView: 1,
      componentType: 5126,
      count: normals.length / 3,
      type: "VEC3",
    },
    {
      bufferView: 2,
      componentType: 5126,
      count: colors.length / 4,
      type: "VEC4",
    },
  ],
};

const jsonSource = JSON.stringify(gltf);
const jsonPadding = (4 - (Buffer.byteLength(jsonSource) % 4)) % 4;
const jsonChunk = Buffer.from(jsonSource + " ".repeat(jsonPadding));
const totalLength = 12 + 8 + jsonChunk.length + 8 + binaryChunk.length;
const glb = Buffer.alloc(totalLength);

glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(totalLength, 8);
glb.writeUInt32LE(jsonChunk.length, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
jsonChunk.copy(glb, 20);

const binaryHeaderOffset = 20 + jsonChunk.length;
glb.writeUInt32LE(binaryChunk.length, binaryHeaderOffset);
glb.writeUInt32LE(0x004e4942, binaryHeaderOffset + 4);
binaryChunk.copy(glb, binaryHeaderOffset + 8);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, glb);
console.log(`Generated ${outputPath} (${glb.length} bytes)`);
