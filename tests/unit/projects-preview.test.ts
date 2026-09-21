import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disableStartPageInConfig } from "../../src/main/services/freecad-xml.js";
import { meshFromTessellation } from "../../src/main/services/preview.js";
import {
  decodeMediaUrl,
  encodeMediaUrl,
  renderMarkdown,
} from "../../src/main/services/markdown.js";
import {
  formatForPath,
  projectFromPath,
  scanProjects,
  withDisplayNames,
} from "../../src/main/services/projects.js";
import {
  meshBounds,
  meshToStlBuffer,
  parseStl,
  parseStlBuffer,
} from "../../src/main/services/stl.js";
import { withTempDir } from "./helpers.js";

const ASCII_STL = `solid s
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 1 0 0
    vertex 1 1 0
    vertex 0 1 0
  endloop
endfacet
endsolid s`;

describe("project scanning", () => {
  it("maps supported extensions", () => {
    expect(formatForPath("a.FCStd")).toBe("FCStd");
    expect(formatForPath("b.stp")).toBe("STEP");
    expect(formatForPath("c.igs")).toBe("IGES");
    expect(formatForPath("d.stl")).toBe("STL");
    expect(formatForPath("e.brep")).toBe("BREP");
    expect(formatForPath("f.txt")).toBeNull();
  });

  it("returns the newest files, recursing and capping the list", async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir, "nested");
      await mkdir(nested, { recursive: true });
      for (let i = 0; i < 25; i += 1) {
        const file = join(dir, `part-${i}.FCStd`);
        await writeFile(file, "x");
        await utimes(file, new Date(2024, 0, 1 + (i % 25)), new Date(2024, 0, 1 + (i % 25)));
      }
      await writeFile(join(nested, "deep.step"), "x");
      const projects = await scanProjects({ dir, limit: 20 });
      expect(projects).toHaveLength(20);
      expect(projects.every((p) => p.path.startsWith(dir))).toBe(true);
      // Newest first.
      for (let i = 1; i < projects.length; i += 1) {
        expect(projects[i - 1]!.modifiedAt >= projects[i]!.modifiedAt).toBe(true);
      }
    });
  });

  it("preserves duplicate filenames with distinct paths and display names", async () => {
    await withTempDir(async (dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await writeFile(join(a, "model.FCStd"), "x");
      await writeFile(join(b, "model.FCStd"), "x");
      const projects = await scanProjects({ dir, limit: 20 });
      expect(projects).toHaveLength(2);
      expect(new Set(projects.map((p) => p.path)).size).toBe(2);
      const named = withDisplayNames(projects);
      expect(named.every((p) => p.displayName.includes("model.FCStd"))).toBe(true);
      expect(new Set(named.map((p) => p.displayName)).size).toBe(2);
    });
  });

  it("reports missing files", async () => {
    expect(await projectFromPath("/definitely/missing.FCStd")).toBeNull();
  });
});

describe("FreeCAD user.cfg editing", () => {
  it("creates the group chain and sets ShowOnStartup to 0", () => {
    const input = `<?xml version="1.0" encoding="UTF-8"?>
<FCConfig>
  <FCParamGroup Name="BaseApp">
    <FCParamGroup Name="Preferences"/>
  </FCParamGroup>
</FCConfig>`;
    const output = disableStartPageInConfig(input);
    expect(output).toContain('Name="ShowOnStartup"');
    expect(output).toContain('Value="0"');
    // Idempotent.
    const again = disableStartPageInConfig(output);
    expect(again.match(/ShowOnStartup/g)?.length).toBe(1);
  });

  it("updates an existing ShowOnStartup value", () => {
    const input = `<FCConfig><FCParamGroup Name="BaseApp"><FCParamGroup Name="Preferences"><FCParamGroup Name="Mod"><FCParamGroup Name="Start"><FCBool Name="ShowOnStartup" Value="1"/></FCParamGroup></FCParamGroup></FCParamGroup></FCParamGroup></FCConfig>`;
    const output = disableStartPageInConfig(input);
    expect(output).toContain('Value="0"');
    expect(output).not.toContain('Value="1"');
  });
});

describe("STL handling", () => {
  it("parses ASCII STL to triangles", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "part.stl");
      await writeFile(file, ASCII_STL);
      const mesh = await parseStl(file);
      expect(mesh.triangleCount).toBe(2);
      expect(mesh.positions).toHaveLength(18);
      const bounds = meshBounds(mesh);
      expect(bounds.min).toEqual([0, 0, 0]);
      expect(bounds.max).toEqual([1, 1, 0]);
    });
  });

  it("round-trips through binary STL", () => {
    const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangleCount: 1 };
    const buffer = meshToStlBuffer(mesh);
    const parsed = parseStlBuffer(buffer);
    expect(parsed.triangleCount).toBe(1);
    expect(parsed.positions.slice(0, 9)).toEqual(mesh.positions);
  });
});

describe("tessellation output parsing", () => {
  it("parses the macro's flat list of points into triangles", () => {
    // Three points (one triangle), exactly how the FreeCAD macro emits them.
    const mesh = meshFromTessellation([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]);
    expect(mesh?.triangleCount).toBe(2);
    expect(mesh?.positions).toHaveLength(18);
    expect(mesh?.positions.slice(0, 9)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it("also accepts flat 9-number triangles", () => {
    const mesh = meshFromTessellation([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
    expect(mesh?.triangleCount).toBe(1);
  });

  it("rejects empty, malformed and non-finite input", () => {
    expect(meshFromTessellation([])).toBeNull();
    expect(meshFromTessellation(null)).toBeNull();
    expect(meshFromTessellation([[0, 0]])).toBeNull();
    expect(meshFromTessellation([[0, 0, 0], [1, 0, 0], ["x", 0, 0]])).toBeNull();
  });
});

describe("markdown rendering", () => {
  it("escapes raw HTML instead of passing it through", () => {
    const html = renderMarkdown("Hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops javascript: links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("keeps https links and rewrites images to the media protocol", () => {
    const html = renderMarkdown(
      "See [FreeCAD](https://github.com/FreeCAD/FreeCAD) and ![pic](https://example.test/a.png)",
      {
        rewriteImage: (url) => encodeMediaUrl(url),
      },
    );
    expect(html).toContain('href="https://github.com/FreeCAD/FreeCAD"');
    expect(html).toContain("freecad-media://media/");
  });

  it("round-trips media URLs and rejects non-https payloads", () => {
    const encoded = encodeMediaUrl("https://example.test/a.png");
    expect(decodeMediaUrl(encoded.replace("freecad-media://media/", ""))).toBe(
      "https://example.test/a.png",
    );
    expect(decodeMediaUrl(Buffer.from("javascript:bad", "utf8").toString("base64url"))).toBeNull();
  });

  it("renders headings, lists and fenced code", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n\n```\ncode & <x>\n```");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<pre><code>code &amp; &lt;x&gt;</code></pre>");
  });
});
