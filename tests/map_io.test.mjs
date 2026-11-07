import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseYaml, updateYamlImage, zipFiles, downloadMapZip, extractMapZip,
  loadMapPair, encodePGM, serializeMap,
} from "../web/js/map_io.js";

test("map YAML original filename stays unchanged", () => {
  const yaml = "image: photo.pgm\nresolution: 0.05\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n";
  assert.equal(parseYaml(yaml).image, "photo.pgm");
  assert.equal(updateYamlImage(yaml, "new.pgm").split("\n")[0], "image: new.pgm");
});

test("map ZIP keeps original YAML and PGM names", async () => {
  const content = new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 255]);
  const map = {
    id: "original", yamlName: "original.yaml", imageName: "photo.pgm",
    yamlText: "image: photo.pgm\nresolution: 0.05\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n",
    imageBlob: new Blob([content]), width: 1, height: 1,
  };
  const { archive, filename } = await downloadMapZip(map);
  assert.match(filename, /^original_\d{8}_\d{6}\.zip$/);
  const names = new TextDecoder().decode(await archive.arrayBuffer());
  assert.ok(names.includes("/original.yaml"));
  assert.ok(names.includes("/photo.pgm"));
  const { File } = await import("node:buffer");
  const files = await extractMapZip(new File([archive], filename));
  assert.deepEqual(files.map((file) => file.name), ["original.yaml", "photo.pgm"]);
  assert.equal(await files[0].text(), map.yamlText);
});

test("ZIP writer produces a valid archive", async () => {
  const archive = await zipFiles([["foo/file.txt", "abc"]]);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
});

function mockMapCanvas() {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {},
      }),
    }),
  };
  return () => { globalThis.document = previous; };
}

test("new map is entirely Free with centered origin and original filenames", async () => {
  const { blankMapFiles, mapFromFiles } = await import("../web/js/map_io.js");
  const { File } = await import("node:buffer");
  const pair = blankMapFiles({
    name: "test_track", width: 20, height: 10, resolution: 0.05, originX: -0.5, originY: -0.25,
  });
  const doc = parseYaml(pair.yamlText);
  assert.deepEqual(doc.origin, [-0.5, -0.25, 0]);
  assert.equal(doc.image, "test_track.pgm");
  const image = new Uint8Array(await pair.imageBlob.arrayBuffer());
  assert.ok(image.slice(image.length - 200).every((pixel) => pixel === 255));
  const restore = mockMapCanvas();
  try {
    const map = await mapFromFiles([
      new File([pair.yamlText], pair.yamlName),
      new File([image], pair.imageName),
    ]);
    assert.equal(map.width, 20);
    assert.equal(map.height, 10);
  } finally { restore(); }
  assert.throws(() => blankMapFiles({
    name: "unsafe/name", width: 10, height: 10, resolution: 0.05, originX: 0, originY: 0,
  }), /Invalid map name/);
});

test("map import retains YAML or image selected in separate steps", async () => {
  const { MapImportSession } = await import("../web/js/map_import.js");
  const { File } = await import("node:buffer");
  const yaml = new File(["image: scan.pgm\nresolution: 0.05\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n"], "map.yaml");
  const image = new File([new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 255])], "scan.pgm");
  const session = new MapImportSession();
  const first = await session.add([image]);
  assert.equal(first.map, null);
  assert.match(first.message, /waiting for YAML/);
  assert.equal(session.pending, true);
  const restore = mockMapCanvas();
  try {
    const second = await session.add([yaml]);
    assert.equal(second.map.yamlName, "map.yaml");
    assert.equal(session.pending, false);
    const reverseFirst = await session.add([yaml]);
    assert.match(reverseFirst.message, /waiting for scan.pgm/);
    const wrong = await session.add([new File(["anything"], "wrong.pgm")]);
    assert.match(wrong.message, /YAML expects scan.pgm/);
    assert.equal(session.pending, true);
    const reverseSecond = await session.add([image]);
    assert.equal(reverseSecond.map.width, 1);
    assert.equal(session.pending, false);
  } finally { restore(); }
});

test("simultaneously mismatched map files request a Toast and keep YAML pending", async () => {
  const { MapImportSession } = await import("../web/js/map_import.js");
  const { File } = await import("node:buffer");
  const yaml = new File([
    "image: scan.pgm\nresolution: 0.05\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n",
  ], "map.yaml");
  const image = new File([
    new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 255]),
  ], "scan.pgm");
  const session = new MapImportSession();
  const mismatch = await session.add([yaml, new File(["bad"], "wrong.pgm")]);
  assert.equal(mismatch.map, null);
  assert.equal(mismatch.error, true);
  assert.match(mismatch.message, /YAML expects scan.pgm/);
  assert.equal(session.pending, true);

  const separate = await session.add([new File(["bad"], "still_wrong.pgm")]);
  assert.equal(separate.error, false);
  const restore = mockMapCanvas();
  try {
    const recovered = await session.add([image]);
    assert.equal(recovered.map.yamlName, "map.yaml");
    assert.equal(session.pending, false);
  } finally { restore(); }
});

test("ZIP import accepts two map files, rejects extra files and mismatched folders", async () => {
  const { File } = await import("node:buffer");
  const yaml = "image: photo.pgm\nresolution: 0.05\norigin: [0,0,0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n";
  const pgm = new Uint8Array([80,53,10,49,32,49,10,50,53,53,10,255]);
  const archive = await zipFiles([["stamp/map.yaml",yaml],["stamp/photo.pgm",pgm]]);
  const files = await extractMapZip(new File([archive],"map.zip"));
  assert.deepEqual(files.map(f => f.name),["map.yaml","photo.pgm"]);
  for (const items of [
    [["map.yaml",yaml],["photo.pgm",pgm],["readme.txt","x"]],
    [["other/map.yaml",yaml],["different/photo.pgm",pgm]],
    [["../map.yaml",yaml],["../photo.pgm",pgm]],
  ]) {
    const bad = await zipFiles(items);
    await assert.rejects(() => extractMapZip(new File([bad],"bad.zip")));
  }
});

test("ROS YAML modes, thresholds, and comments use a proper parser", async () => {
  const { parseYaml, updateYamlImage } = await import("../web/js/map_io.js");
  const text = `# map metadata
image: "track.bmp" # paired image
resolution: 0.025
origin:
  - -2.5
  - 3
  - 0.785
negate: 1
mode: scale
occupied_thresh: 0.7
free_thresh: 0.2
robot_metadata:
  calibration: true
`;
  const map = parseYaml(text);
  assert.equal(map.mode, "scale");
  assert.deepEqual(map.origin, [-2.5, 3, 0.785]);
  assert.equal(map.extra.robot_metadata.calibration, true);
  const result = updateYamlImage(text, "track.png");
  assert.match(result, /image: track.png # paired image/);
  assert.match(result, /robot_metadata:\n  calibration: true/);
  assert.match(result, /# map metadata/);
  for (const bad of [
    "origin: [0, 0, .nan]", "resolution: -.inf", "mode: unknown",
    "free_thresh: 0.9", "image: ../unsafe.png", "negate: 2",
  ]) {
    const base = "image: track.png\nresolution: 0.05\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n";
    const key = bad.split(":")[0];
    const replaced = base.split("\n").filter((line) => !line.startsWith(`${key}:`)).join("\n") + `\n${bad}\n`;
    assert.throws(() => parseYaml(replaced));
  }
});

test("ROS map YAML requires negate and both thresholds; mode remains optional", () => {
  const baseline = `image: track.pgm
resolution: 0.05
origin: [0, 0, 0]
negate: 0
occupied_thresh: 0.65
free_thresh: 0.196
`;
  assert.equal(parseYaml(baseline).mode, "trinary");
  for (const missing of ["negate", "free_thresh", "occupied_thresh"]) {
    const lines = baseline.split("\n").filter((line) => !line.startsWith(`${missing}:`));
    assert.throws(() => parseYaml(lines.join("\n")), new RegExp(missing));
  }
});

test("PGM P2 and P5 decode 8-bit samples and reject 16-bit PGM", async () => {
  const { decodePGM } = await import("../web/js/map_io.js");
  const encoder = new TextEncoder();
  assert.deepEqual([...decodePGM(encoder.encode("P2\n# comment\n3 1\n15\n0 7 15\n")).pixels],[0,119,255]);
  assert.deepEqual([...decodePGM(Uint8Array.from([...encoder.encode("P5\n3 1\n255\n"),0,128,255])) .pixels],[0,128,255]);
  assert.throws(() => decodePGM(encoder.encode("P5\n1 1\n65535\n\0\0")),/8-bit/);
});

test("PGM encoding round-trips 8-bit grayscale values", async () => {
  const { encodePGM, decodePGM } = await import("../web/js/map_io.js");
  const blob = encodePGM(3,1,Uint8Array.from([0,128,255]));
  assert.deepEqual([...decodePGM(new Uint8Array(await blob.arrayBuffer())).pixels],[0,128,255]);
});

test("high-depth PNG is rejected without browser bitmap decoding", async () => {
  const { loadMapPair } = await import("../web/js/map_io.js");
  const bytes = new Uint8Array(26), view = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  view.setUint32(16,1); view.setUint32(20,1); bytes[24] = 16;
  const yaml = "image: hi.png\nresolution: 0.05\norigin: [0,0,0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n";
  await assert.rejects(loadMapPair("hi.yaml",yaml,"hi.png",new Blob([bytes])),/16-bit PNG/);
});

test("edited PGM maps are encoded from occupancy cells", async () => {
  const { loadMapPair, serializeMap, decodePGM } = await import("../web/js/map_io.js");
  const text = "image: a.pgm\nresolution: 0.05\norigin: [0,0,0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n";
  const pgm = new TextEncoder().encode("P5\n2 1\n255\n");
  const map = await loadMapPair("a.yaml",text,"a.pgm",new Blob([pgm,Uint8Array.from([255,0])]));
  assert.deepEqual([...map.cells],[0,100]);
  map.cells[0] = 100;
  const saved = await serializeMap(map,map.cells,null,true);
  const output = decodePGM(new Uint8Array(await saved.imageBlob.arrayBuffer()));
  assert.deepEqual([...output.pixels],[0,0]);
});

test("BMP encoder emits a standard 24-bit BMP header", async () => {
  const { encodeBMP } = await import("../web/js/map_io.js");
  const rgba = Uint8ClampedArray.from([0,0,0,255,255,255,255,255]);
  const bytes = new Uint8Array(await encodeBMP(2,1,rgba).arrayBuffer());
  assert.equal(bytes[0],66); assert.equal(bytes[1],77);
  assert.equal(new DataView(bytes.buffer).getInt32(18,true),2);
});

test("scale Unknown forces PNG and preserves other YAML text", async () => {
  const { serializeMap } = await import("../web/js/map_io.js");
  const originalDocument = globalThis.document, originalImageData = globalThis.ImageData;
  globalThis.ImageData = class { constructor(data) { this.data=data; } };
  globalThis.document = { createElement() { return { getContext() { return { putImageData() {} }; },
    toBlob(callback) { callback(new Blob([1,2,3])); } }; } };
  try {
    const text = "image: a.pgm # keep\nresolution: 0.05\norigin: [0,0,0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\nmode: scale\n# comment\n";
    const doc = { id:"a",yamlName:"a.yaml",yamlText:text,imageName:"a.pgm",imageBlob:new Blob([]),width:1,height:1,
      mode:"scale",negate:0,freeThresh:0.196,occupiedThresh:0.65 };
    const saved = await serializeMap(doc,Int8Array.from([-1]),null,true);
    assert.equal(saved.imageName,"a.png");
    assert.match(saved.yamlText,/image: a.png # keep/);
    assert.match(saved.yamlText,/# comment/);
  } finally { globalThis.document=originalDocument; globalThis.ImageData=originalImageData; }
});

test("ZIP reader accepts archives from another ZIP implementation", async () => {
  const { File } = await import("node:buffer");
  // Created with Python's zipfile.
  const external = "UEsDBBQAAAAIAIEhZl1IYPGsNAAAADUAAAANAAAAZXh0ZXJuYWwueWFtbMvMTUxPtVJIrShJLcpLzNErSM/lKkotzs8pLcnMz7NSMNAzMOXKL8pMzwRyog10gDCWCwBQSwMEFAAAAAgAgSFmXfKI0rMRAAAADwAAAAwAAABleHRlcm5hbC5wZ20LMOUyUjDiMjI15frPUP8fAFBLAQIUAxQAAAAIAIEhZl1IYPGsNAAAADUAAAANAAAAAAAAAAAAAACAAQAAAABleHRlcm5hbC55YW1sUEsBAhQDFAAAAAgAgSFmXfKI0rMRAAAADwAAAAwAAAAAAAAAAAAAAIABXwAAAGV4dGVybmFsLnBnbVBLBQYAAAAAAgACAHUAAACaAAAAAAA=";
  const bytes = new Uint8Array(Buffer.from(external, "base64"));
  const files = await extractMapZip(new File([bytes], "external.zip"));
  assert.deepEqual(files.map((file) => file.name), ["external.yaml", "external.pgm"]);
  assert.match(await files[0].text(), /resolution: 0\.05/);
  assert.equal((await files[1].arrayBuffer()).byteLength, 15);
});

test("ZIP reader rejects an entry larger than configured size limit", async () => {
  const { File } = await import("node:buffer");
  const archive = new Uint8Array(await (await zipFiles([["a.yaml","a"],["a.pgm","b"]])).arrayBuffer());
  const central = archive.findIndex((byte,i)=>byte===80&&archive[i+1]===75&&archive[i+2]===1&&archive[i+3]===2);
  assert.ok(central>=0);
  new DataView(archive.buffer).setUint32(central+24, 65_000_000, true);
  await assert.rejects(extractMapZip(new File([archive],"large.zip")),/64 MB/);
});

test("ZIP writer rejects duplicate entry names", async () => {
  await assert.rejects(zipFiles([["map.yaml","a"],["map.yaml","b"]]),/Duplicate/);
});

test("ZIP reader accepts a common enclosing directory", async () => {
  const { File } = await import("node:buffer");
  const archive = await zipFiles([["track/track.yaml","hello"],["track/track.pgm",Uint8Array.from([1,2])]]);
  const files = await extractMapZip(new File([archive],"folder.zip"));
  assert.deepEqual(files.map(file=>file.name),["track.yaml","track.pgm"]);
});

test("oversized PNG and BMP headers are rejected before native decoding", async () => {
  const { loadMapPair } = await import("../web/js/map_io.js");
  const yaml = name=>`image: ${name}\nresolution: 0.05\norigin: [0,0,0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n`;
  const png=new Uint8Array(26),pview=new DataView(png.buffer);
  png.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  pview.setUint32(16,6000);pview.setUint32(20,5000);
  const bmp=new Uint8Array(26),bview=new DataView(bmp.buffer);
  bmp.set([66,77]);bview.setUint32(14,40,true);bview.setInt32(18,6000,true);bview.setInt32(22,5000,true);
  for (const [name,data] of [["a.png",png],["a.bmp",bmp]]) {
    await assert.rejects(loadMapPair("a.yaml",yaml(name),name,new Blob([data])),/too large/);
  }
});

test("browser YAML exponent numerics match the API metadata parser", () => {
  const baseline = "image: track.png\nresolution: 5e-2\norigin: [1e0, -2E0, 0]\nnegate: 0\noccupied_thresh: 6.5e-1\nfree_thresh: 1.96e-1\n";
  const result = parseYaml(baseline);
  assert.equal(result.resolution, 0.05);
  assert.deepEqual(result.origin, [1, -2, 0]);
  assert.equal(result.occupiedThresh, 0.65);
  assert.equal(result.freeThresh, 0.196);
});

test("YAML updater changes only top-level image and preserves CRLF/comments", () => {
  const text="metadata:\r\n  image: other.png\r\nimage: old.png # keep\r\nresolution: 0.05\r\norigin: [0,0,0]\r\nnegate: 0\r\nfree_thresh: 0.196\r\noccupied_thresh: 0.65\r\n";
  const updated=updateYamlImage(text,"new.pgm");
  assert.match(updated,/  image: other.png\r\nimage: new.pgm # keep/);
  assert.equal(parseYaml(updated).image,"new.pgm");
  const flow="{image: old.png, resolution: 0.05, origin: [0,0,0], negate: 0, free_thresh: 0.196, occupied_thresh: 0.65}";
  assert.throws(()=>updateYamlImage(flow,"new.pgm"),/Cannot update image/);
});

test("ZIP reader validates entry paths",async()=>{
  const {File}=await import("node:buffer");
  const valid=await zipFiles([["map/map.yaml","one"],["map/map.pgm",Uint8Array.from([3])]]);
  assert.deepEqual((await extractMapZip(new File([valid],"a.zip"))).map(f=>f.name),["map.yaml","map.pgm"]);
  const invalid=await zipFiles([["../map.yaml","one"],["../map.pgm",Uint8Array.from([3])]]);
  await assert.rejects(extractMapZip(new File([invalid],"bad.zip")),/Unsafe filename|folder/);
});

test("PGM → OccupancyGrid → edited YAML/PGM → ZIP → OccupancyGrid",async()=>{
  const {File}=await import("node:buffer");
  const yaml = "image: sample.pgm # preserve\nresolution: 0.05\norigin: [1,2,0.2]\nnegate: 0\nfree_thresh: 0.196\noccupied_thresh: 0.65\nnotes: kept\n";
  const original = encodePGM(3,1,Uint8Array.from([255,205,0]));
  const map = await loadMapPair("sample.yaml",yaml,"sample.pgm",original);
  assert.deepEqual([...map.cells],[0,-1,100]);
  map.cells[0] = 100;
  const serialized = await serializeMap(map,map.cells,"edited",true);
  assert.match(serialized.yamlText,/image: edited.pgm # preserve/);
  assert.match(serialized.yamlText,/notes: kept/);
  assert.equal(map.yamlText,yaml);
  const reread = await loadMapPair(serialized.yamlName,serialized.yamlText,serialized.imageName,serialized.imageBlob);
  assert.deepEqual([...reread.cells],[100,-1,100]);
  const { archive } = await downloadMapZip(map,map.cells,"edited",true);
  const files = await extractMapZip(new File([archive],"edited.zip"));
  const parsed = await (async()=>{
    const yamlFile=files.find(f=>f.name.endsWith(".yaml"));
    const imageFile=files.find(f=>f.name.endsWith(".pgm"));
    return loadMapPair(yamlFile.name,await yamlFile.text(),imageFile.name,imageFile);
  })();
  assert.deepEqual([...parsed.cells],[100,-1,100]);
});
