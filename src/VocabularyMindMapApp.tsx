import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { jsPDF } from "jspdf";

/**
 * 英単語暗記用マインドマップ Web アプリ（改良版）
 * - 左：テキストエディタ／右：マインドマップ
 * - インデントで階層（タブ or スペース2個）
 * - \color{#RRGGBB | presetName} で色指定（親色は子に継承）
 *   presets: red, blue, green, orange, purple, teal, pink, gray, slate, amber, lime
 * - \label{name} でラベル／本文の \ref{name} は表示から除去してクロスリンクのみ描画
 * - 品詞タグ：\pos{noun|verb|adj|adv|prep|conj|pron|interj}
 * - 任意タグ：\tags{tag1, tag2}
 * - 日本語訳：\jp{日本語訳} を本文に付けると、ノードクリックで alert 表示されます
 * - タグ検索：入力に合致するタグを持つノードをハイライト（AND検索）
 * - マウスドラッグで右側のマインドマップをパン、スライダーでズーム
 * - Enterで自動インデント改行／Tab/Shift+Tabでインデント調整
 * - localStorage にテキスト・設定保存、スナップショット履歴（手動・最大30件）
 * - 仕切りバーをドラッグして左右パネル幅を変更（15%〜85%）
 * - ヘッダーに PDF 出力ボタン（右パネル全体を 1 ページ PDF 保存）
 */

// --- 型定義 ---
interface RawNode {
  id: string;
  depth: number;
  line: number; // 0-based line index
  text: string; // 表示テキスト（タグ等は除去、\ref は非表示）
  jp?: string; // ★ 追加: 日本語訳（\jp{...}）
  label?: string;
  color?: string; // 指定色（継承前）
  effectiveColor?: string; // 継承後の有効色
  refs: string[]; // このノードから参照しているラベル名
  pos?: string; // 品詞
  tags: string[]; // 任意タグ（pos も含めてよい）
  children: RawNode[];
}

// カラープリセット
const COLOR_PRESETS: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  orange: "#f59e0b",
  purple: "#a78bfa",
  teal: "#14b8a6",
  pink: "#ec4899",
  gray: "#6b7280",
  slate: "#64748b",
  amber: "#f59e0b",
  lime: "#84cc16",
};

// 初期テキスト（例）
const SAMPLE = `Root \\color{slate}
  Food \\color{blue} \\tags{topic, daily}
    fruit 
      apple \\label{apple} \\pos{noun} \\jp{りんご}
      banana \\pos{noun} \\jp{バナナ}
      cherry \\pos{noun}
    vegetable 
      carrot \\pos{noun} \\jp{にんじん}
      onion \\pos{noun}
  Study \\color{purple}
    vocabulary 
      antonyms \\ref{apple}
      synonyms \\jp{類義語}
    grammar \\tags{hard}
  Travel \\color{green}
    airport \\pos{noun} \\jp{空港}
    hotel \\pos{noun}
      check-in \\pos{noun}
      check-out \\pos{noun}`;

// ユーティリティ：行頭インデントの深さ（タブ or スペース2つ=1段）
function getDepth(s: string) {
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\t") {
      depth += 1;
      i += 1;
    } else if (s[i] === " ") {
      // 2 spaces per level
      if (s[i + 1] === " ") {
        depth += 1;
        i += 2;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return { depth, rest: s.slice(i) };
}

// 色文字列を解決（#hex またはプリセット名）
function resolveColor(str?: string): string | undefined {
  if (!str) return undefined;
  const s = str.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
  const preset = COLOR_PRESETS[s.toLowerCase()];
  return preset ?? undefined;
}

// テキストをパースしてツリーを構築
function parseText(input: string): { root: RawNode; labelToId: Map<string, string> } {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const root: RawNode = {
    id: "root",
    depth: -1,
    line: -1,
    text: "root",
    color: undefined,
    refs: [],
    tags: [],
    children: [],
  };

  const stack: RawNode[] = [root];
  const labelToId = new Map<string, string>();

  lines.forEach((raw, idx) => {
    if (!raw.trim()) return; // 空行はスキップ

    const { depth, rest } = getDepth(raw);

    // タグ抽出
    let text = rest.trim();
    let colorRaw: string | undefined = undefined;
    let label: string | undefined = undefined;
    let pos: string | undefined = undefined;
    let jp: string | undefined = undefined; // ★ 追加
    const refs: string[] = [];
    const tags: string[] = [];

    // \\\\color{...}
    const colorMatch = text.match(/\\\\?color\{([^}]+)\}/i);
    if (colorMatch) {
      colorRaw = colorMatch[1].trim();
      text = text.replace(colorMatch[0], "").trim();
    }
    // \\\\label{name}
    const labelMatch = text.match(/\\\\?label\{([^}]+)\}/);
    if (labelMatch) {
      label = labelMatch[1].trim();
      text = text.replace(labelMatch[0], "").trim();
    }
    // \\\\pos{tag}
    const posMatch = text.match(/\\\\?pos\{([^}]+)\}/i);
    if (posMatch) {
      pos = posMatch[1].trim().toLowerCase();
      text = text.replace(posMatch[0], "").trim();
    }
    // \\\\jp{日本語}
    const jpMatch = text.match(/\\\\?jp\{([^}]+)\}/i);
    if (jpMatch) {
      jp = jpMatch[1].trim();
      text = text.replace(jpMatch[0], "").trim();
    }
    // \\\\tags{a,b,c}
    const tagsMatch = text.match(/\\\\?tags\{([^}]+)\}/i);
    if (tagsMatch) {
      const arr = tagsMatch[1]
        .split(/[\,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      tags.push(...arr);
      text = text.replace(tagsMatch[0], "").trim();
    }
    if (pos) tags.push(pos); // pos も tags に含める

    // \\\\ref{name}（複数可） ※表示テキストからは除去
    const refRegex = /\\\\?ref\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = refRegex.exec(text))) refs.push(m[1].trim());
    text = text.replace(refRegex, "").replace(/\s{2,}/g, " ").trim();

    const node: RawNode = {
      id: `n_${idx}`,
      depth,
      line: idx,
      text: text.length ? text : "(untitled)",
      jp,
      color: resolveColor(colorRaw),
      label,
      refs,
      pos,
      tags,
      children: [],
    };

    // スタック調整
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);

    if (label) labelToId.set(label, node.id);
  });

  // 色の継承を適用
  function applyColor(node: RawNode, inherited?: string) {
    const cur = node.color ?? inherited;
    node.effectiveColor = cur;
    node.children.forEach((c) => applyColor(c, cur));
  }
  applyColor(root, undefined);

  return { root, labelToId };
}

// ノード位置付けのため d3.hierarchy へ変換
function toHierarchy(root: RawNode) {
  return d3.hierarchy<RawNode>(root, (d) => d.children);
}

// エッジ描画（ツリー用の斜めベジェ）
function diagonal(s: { x: number; y: number }, t: { x: number; y: number }) {
  const path = `M ${s.y},${s.x} C ${(s.y + t.y) / 2},${s.x} ${(s.y + t.y) / 2},${t.x} ${t.y},${t.x}`;
  return path;
}

// --- エディタ補助（自動インデント）---
function leadingIndent(s: string) {
  const m = s.match(/^(\t+|(?: {2})+)/);
  return m ? m[0] : "";
}
function nextLineIndent(prevLine: string) { return leadingIndent(prevLine); }

// --- 簡易テストユーティリティ ---
interface TestResult { name: string; ok: boolean; details?: string }
function runSelfTests(): TestResult[] {
  const results: TestResult[] = [];
  const assert = (name: string, cond: boolean, details = "") => results.push({ name, ok: !!cond, details: cond ? undefined : details });

  // 1) インデント階層の解釈
  const t1 = parseText(`A\n  B\n    C`);
  const A = t1.root.children[0];
  const B = A?.children[0];
  const C = B?.children[0];
  assert("indent depth A=0", A?.depth === 0, `got ${A?.depth}`);
  assert("indent depth B=1", B?.depth === 1, `got ${B?.depth}`);
  assert("indent depth C=2", C?.depth === 2, `got ${C?.depth}`);

  // 2) 色の継承 + プリセット
  const t2 = parseText(`Parent \\color{red}\n  Child`);
  const P = t2.root.children[0];
  const Ch = P?.children[0];
  assert("color preset resolved", P?.effectiveColor === COLOR_PRESETS.red, `got ${P?.effectiveColor}`);
  assert("color inherited to child", Ch?.effectiveColor === COLOR_PRESETS.red, `got ${Ch?.effectiveColor}`);

  // 3) ラベルと参照（表示からは除去）
  const t3 = parseText(`node \\label{apple}\nuse \\ref{apple} here`);
  const labelId = t3.labelToId.get("apple");
  const refNode = t3.root.children[1];
  assert("label mapping exists", !!labelId);
  assert("ref captured on second line", refNode?.refs.includes("apple") === true, `refs=${refNode?.refs}`);
  assert("ref removed from display text", !/\\ref\{/.test(refNode?.text || ""), `text=${refNode?.text}`);

  // 4) 品詞・タグの取り込み + 日本語訳
  const t4 = parseText(`word \\pos{noun} \\tags{food, basic} \\jp{ことば}`);
  const n4 = t4.root.children[0];
  assert("pos stored", n4?.pos === "noun", `pos=${n4?.pos}`);
  assert("tags stored", n4?.tags.includes("food") && n4?.tags.includes("basic"), `tags=${n4?.tags}`);
  assert("jp stored", n4?.jp === "ことば", `jp=${n4?.jp}`);

  // 5) SAMPLE 文字列がパースできる
  try {
    const sampleParsed = parseText(SAMPLE);
    assert("SAMPLE has at least one child", sampleParsed.root.children.length > 0);
  } catch (e) {
    assert("SAMPLE parse should not throw", false, String(e));
  }

  // 6) 自動インデントの検証
  assert("indent carry: two spaces", nextLineIndent("  foo") === "  ");
  assert("indent carry: tabs", nextLineIndent("\t\tbar") === "\t\t");
  assert("indent carry: mix two-spaces only", nextLineIndent("    baz") === "    ");

  // 7) 色指定: #HEX と未知プリセット
  const t5 = parseText(`X \\color{#abc}\n  Y\nZ \\color{unknown}`);
  const x = t5.root.children[0];
  const y = x?.children[0];
  const z = t5.root.children[1];
  assert("hex color resolved (#abc -> effective)", /^#/.test(x?.effectiveColor || ""));
  assert("hex propagation to child", y?.effectiveColor === x?.effectiveColor, `child=${y?.effectiveColor} parent=${x?.effectiveColor}`);
  assert("unknown preset ignored", !z?.effectiveColor, `z=${z?.effectiveColor}`);

  // 8) resolveColor: 大文字プリセットや #6桁HEX
  assert("preset case-insensitive", resolveColor("RED") === COLOR_PRESETS.red);
  assert("6-digit hex ok", resolveColor("#123456") === "#123456");

  return results;
}

export default function VocabularyMindMapApp() {
  const [text, setText] = useState<string>(SAMPLE);
  const [zoom, setZoom] = useState(1);
  const [hSpace, setHSpace] = useState(140); // 水平距離
  const [vSpace, setVSpace] = useState(48); // 垂直距離
  const [tagQuery, setTagQuery] = useState<string>("");
  const [leftPct, setLeftPct] = useState<number>(50);
  const panelsRef = useRef<HTMLDivElement | null>(null);
  const splitDragRef = useRef<{ dragging: boolean; startX: number; startPct: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const exportSvgRef = useRef<SVGSVGElement | null>(null);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ dragging: boolean; sx: number; sy: number; pan0: { x: number; y: number } } | null>(null);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

  // --- ローカル履歴＆設定保存 ---
  type Snapshot = { ts: number; text: string };
  const [history, setHistory] = useState<Snapshot[]>([]);
  const STORAGE_KEY = "vocab-mindmap/text";
  const STORAGE_META_KEY = "vocab-mindmap/meta";
  const STORAGE_HISTORY_KEY = "vocab-mindmap/history";

  useEffect(() => { setTestResults(runSelfTests()); }, []);

  // 初期ロード：保存済みデータ
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const histStr = localStorage.getItem(STORAGE_HISTORY_KEY);
      if (saved) setText(saved);
      if (histStr) setHistory(JSON.parse(histStr));
      const metaStr = localStorage.getItem(STORAGE_META_KEY);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        if (typeof meta.zoom === 'number') setZoom(meta.zoom);
        if (typeof meta.hSpace === 'number') setHSpace(meta.hSpace);
        if (typeof meta.vSpace === 'number') setVSpace(meta.vSpace);
        if (typeof meta.tagQuery === 'string') setTagQuery(meta.tagQuery);
        if (typeof meta.leftPct === 'number') setLeftPct(Math.max(15, Math.min(85, meta.leftPct)));
      }
    } catch {}
  }, []);

  // オートセーブ（テキスト＆メタ）
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, text); } catch {} }, [text]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_META_KEY, JSON.stringify({ zoom, hSpace, vSpace, tagQuery, leftPct })); } catch {}
  }, [zoom, hSpace, vSpace, tagQuery, leftPct]);

  // スナップショット保存（手動のみ）
  const saveSnapshot = () => {
    const snap = { ts: Date.now(), text } as Snapshot;
    const next = [snap, ...history].slice(0, 30);
    setHistory(next);
    try { localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(next)); } catch {}
  };

  const parsed = useMemo(() => parseText(text), [text]);
  const hierarchy = useMemo(() => toHierarchy(parsed.root), [parsed]);

  const treeLayout = useMemo(
    () => d3.tree<RawNode>().nodeSize([vSpace, hSpace]).separation(() => 1.1),
    [hSpace, vSpace]
  );
  const treeRoot = useMemo(() => treeLayout(hierarchy), [treeLayout, hierarchy]);

  // ノード位置のマップ
  const nodePos = useMemo(() => {
    const map = new Map<string, { x: number; y: number; data: RawNode }>();
    treeRoot.each((d) => { if (d.data.id) map.set(d.data.id, { x: d.x, y: d.y, data: d.data }); });
    return map;
  }, [treeRoot]);

  // ラベル->ID を用いてクロスリンクの座標を作成
  const crossLinks = useMemo(() => {
    const links: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; color?: string }> = [];
    treeRoot.each((d) => {
      const data: RawNode = d.data as RawNode;
      if (data.refs?.length) {
        data.refs.forEach((r) => {
          const targetId = parsed.labelToId.get(r);
          const from = nodePos.get(data.id);
          const to = targetId ? nodePos.get(targetId) : undefined;
          if (from && to && from !== to) links.push({ from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, color: data.effectiveColor });
        });
      }
    });
    return links;
  }, [treeRoot, parsed.labelToId, nodePos]);

  // エディタ内のカーソル行に紐づくノード（強調表示用）
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const handleSelectLine = (lineIdx: number) => {
    const ta = textareaRef.current; if (!ta) return;
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let start = 0; for (let i = 0; i < lineIdx; i++) start += lines[i].length + 1;
    const end = start + (lines[lineIdx]?.length ?? 0);
    ta.focus(); ta.setSelectionRange(start, end); setCaretLine(lineIdx);
  };
  const onEditorCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget; const upto = (ta as HTMLTextAreaElement).selectionStart ?? 0;
    const before = (ta as HTMLTextAreaElement).value.slice(0, upto).replace(/\r\n?/g, "\n");
    const line = before.split("\n").length - 1; setCaretLine(line);
  };

  // テキストエディタのキー処理
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    // Ctrl/Cmd+S -> snapshot
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveSnapshot(); return; }

    if (e.key === 'Enter') {
      e.preventDefault();
      const value = ta.value;
      const start = ta.selectionStart ?? 0; const end = ta.selectionEnd ?? 0;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const prevLineStart = before.lastIndexOf('\n') + 1;
      const prevLine = before.slice(prevLineStart);
      const indent = nextLineIndent(prevLine);
      const insert = "\n" + indent;
      const next = before + insert + after;
      setText(next);
      const caret = (before.length + insert.length);
      requestAnimationFrame(() => { ta.setSelectionRange(caret, caret); onEditorCursor({ currentTarget: ta } as any); });
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const value = ta.value; const selStart = ta.selectionStart ?? 0; const selEnd = ta.selectionEnd ?? 0;
      const lineStart = value.lastIndexOf('\n', selStart - 1) + 1;
      const lineEnd = value.indexOf('\n', selEnd); const actualLineEnd = lineEnd === -1 ? value.length : lineEnd;
      const selection = value.slice(lineStart, actualLineEnd);
      const isShift = e.shiftKey;
      const lines = selection.split('\n');
      const changed = lines.map((ln) => {
        if (isShift) {
          // outdent 2 spaces or 1 tab
          if (ln.startsWith('\t')) return ln.slice(1);
          if (ln.startsWith('  ')) return ln.slice(2);
          return ln;
        } else {
          // indent by two spaces (editor uses 2-space level)
          return '  ' + ln;
        }
      }).join('\n');
      const next = value.slice(0, lineStart) + changed + value.slice(actualLineEnd);
      setText(next);
      const delta = changed.length - selection.length;
      const newStart = selStart + (isShift ? 0 : 2);
      const newEnd = selEnd + delta;
      requestAnimationFrame(() => { ta.setSelectionRange(newStart, newEnd); onEditorCursor({ currentTarget: ta } as any); });
      return;
    }
  };

  // ノード -> 行番号のマップ
  const idToLine = useMemo(() => {
    const m = new Map<string, number>();
    treeRoot.each((d) => {
      if (typeof (d.data as RawNode).line === "number" && (d.data as RawNode).line >= 0) m.set((d.data as RawNode).id, (d.data as RawNode).line);
    });
    return m;
  }, [treeRoot]);

  // SVG のサイズ計算
  const padding = 80;
  const [minX, maxX, minY, maxY] = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    treeRoot.each((d) => { minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x); minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y); });
    return [minX, maxX, minY, maxY];
  }, [treeRoot]);
  const width = Math.max(600, maxY - minY + padding * 2);
  const height = Math.max(400, maxX - minX + padding * 2);
  const originX = minY - padding;
  const originY = minX - padding;

  // --- タグフィルタ（AND）
  const wantedTags = useMemo(() => tagQuery.toLowerCase().split(/[ ,]+/).map(s=>s.trim()).filter(Boolean), [tagQuery]);
  const nodeMatches = (n: RawNode) => wantedTags.length === 0 || wantedTags.every(t => n.tags.includes(t));

  // --- パン（ドラッグ）
  const onSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    dragRef.current = { dragging: true, sx: e.clientX, sy: e.clientY, pan0: { ...pan } };
  };
  const onSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current?.dragging || !svgRef.current) return;
    const vb = svgRef.current.viewBox.baseVal; // viewBox の座標幅
    const cw = svgRef.current.clientWidth; const ch = svgRef.current.clientHeight;
    const scaleX = vb.width / cw; const scaleY = vb.height / ch;
    const dxPx = e.clientX - dragRef.current.sx; const dyPx = e.clientY - dragRef.current.sy;
    // ズームと viewBox の両方を考慮（ズームで拡大しているほど小さく動かす）
    const nx = dragRef.current.pan0.x + (dxPx * scaleX) / zoom;
    const ny = dragRef.current.pan0.y + (dyPx * scaleY) / zoom;
    setPan({ x: nx, y: ny });
  };
  const onSvgMouseUp = () => { if (dragRef.current) dragRef.current.dragging = false; };
  const onSvgMouseLeave = () => { if (dragRef.current) dragRef.current.dragging = false; };

  // --- PDF 出力 ---
  const exportPDF = async () => {
    const svg = exportSvgRef.current; // 変換専用の隠しSVG（パン・ズーム無視、全体）
    if (!svg) return;
    const serializer = new XMLSerializer();
    // 一時的に xmlns を保証
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const source = serializer.serializeToString(svg);
    const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        // 高解像度化のためスケール
        const scale = 2; // 2x
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) { URL.revokeObjectURL(url); return resolve(); }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // PDF へ貼り付け（pt 単位に変換: 1px = 72/96pt）
        const pxToPt = (n: number) => (n * 72) / 96;
        const wPt = pxToPt(img.width * scale);
        const hPt = pxToPt(img.height * scale);
        const orientation = wPt >= hPt ? "landscape" : "portrait";
        const doc = new jsPDF({ orientation, unit: "pt", format: [wPt, hPt] });
        const png = canvas.toDataURL("image/png");
        doc.addImage(png, "PNG", 0, 0, wPt, hPt);
        doc.save("mindmap.pdf");
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });
  };

  // --- リサイズ用スプリッタ ---
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const onSplitterDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!panelsRef.current) return;
    splitDragRef.current = { dragging: true, startX: e.clientX, startPct: leftPct };
    const onMove = (ev: MouseEvent) => {
      if (!splitDragRef.current?.dragging || !panelsRef.current) return;
      const rect = panelsRef.current.getBoundingClientRect();
      const dx = ev.clientX - splitDragRef.current.startX;
      const pct = clamp(splitDragRef.current.startPct + (dx / rect.width) * 100, 15, 85);
      setLeftPct(pct);
    };
    const onUp = () => {
      if (splitDragRef.current) splitDragRef.current.dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  // --- ノードクリック（日本語訳 alert + テキスト行選択）---
  const onNodeClick = (data: RawNode) => {
    if (data.jp && data.jp.trim().length > 0) {
      // 例: "apple : りんご" のように表示
      alert(`${data.text} : ${data.jp}`);
    }
    const line = idToLine.get(data.id);
    if (typeof line === "number") handleSelectLine(line);
  };

  return (
    <div className="w-full h-[100vh] bg-neutral-50 text-neutral-800" data-app-root>

      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
        <div className="font-semibold">Word Wald by H.K.</div>
        <div className="flex items-center gap-3 flex-wrap" data-toolbar>
          <div className="text-sm text-neutral-500 hidden lg:block">
            インデント: タブ/スペース2個 ｜ 色: <code>\\color</code>{'{#hex|name}'} ｜ ラベル: <code>\\label</code>{'{name}'} ｜ 参照: <code>\\ref</code>{'{name}'} ｜ 品詞: <code>\\pos</code>{'{noun}'} ｜ タグ: <code>\\tags</code>{'{a,b}'} ｜ 和訳: <code>\\jp</code>{'{日本語}' }
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs">Zoom</label>
            <input type="range" min={0.6} max={2.0} step={0.05} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} />
          </div>
          <div className="flex items-center gap-2">
            <button className="text-xs border px-2 py-1 rounded" onClick={exportPDF} title="右パネルをPDF保存">PDF出力</button>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs" title="タグ AND 検索（空欄で全表示）">タグ検索</label>
            <input className="border rounded px-2 py-1 text-sm" placeholder="noun, topic" value={tagQuery} onChange={(e)=>setTagQuery(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <button className="text-xs border px-2 py-1 rounded" onClick={saveSnapshot} title="現在のテキストをスナップショット保存 (Ctrl+S)">履歴へ保存</button>
            <details className="text-xs">
              <summary className="cursor-pointer select-none">履歴 {history.length}</summary>
              <div className="mt-1 max-h-48 overflow-auto border rounded p-2 bg-white shadow-sm">
                {history.length === 0 && <div className="text-neutral-500">（まだありません）</div>}
                {history.map((h, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 py-1 border-b last:border-b-0">
                    <div className="truncate max-w-[12rem]">{new Date(h.ts).toLocaleString()}</div>
                    <div className="flex items-center gap-2">
                      <button className="border px-2 py-0.5 rounded" onClick={() => setText(h.text)}>復元</button>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      </div>

      {/* 本体 2 分割 */}
      <div ref={panelsRef} className="h-[calc(100vh-44px)] flex">
        {/* 左：テキストエディタ */}
        <div className="border-r bg-white" style={{ width: `${leftPct}%` }}>
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <div className="text-sm font-medium">テキストエディタ</div>
              <div className="flex items-center gap-3 text-xs text-neutral-600">
                <div className="flex items-center gap-1">
                  <span>水平</span>
                  <input type="number" className="w-16 border rounded px-1 py-0.5" value={hSpace} onChange={(e) => setHSpace(Math.max(60, Number(e.target.value) || 140))} title="ノード間の水平間隔" />
                </div>
                <div className="flex items-center gap-1">
                  <span>垂直</span>
                  <input type="number" className="w-16 border rounded px-1 py-0.5" value={vSpace} onChange={(e) => setVSpace(Math.max(24, Number(e.target.value) || 48))} title="ノード間の垂直間隔" />
                </div>
              </div>
            </div>
            <textarea
              ref={textareaRef}
              className="flex-1 w-full outline-none p-3 font-mono text-sm leading-6"
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              onClick={onEditorCursor}
              onKeyUp={onEditorCursor}
              onKeyDown={(e)=>handleEditorKeyDown(e)}
            />
          </div>
        </div>

        {/* 仕切り（ドラッグで左右サイズ変更） */}
        <div
          role="separator"
          aria-orientation="vertical"
          title={`${leftPct.toFixed(0)}%`}
          className="w-1.5 bg-transparent hover:bg-slate-300/50 cursor-col-resize"
          onMouseDown={onSplitterDown}
        />

        {/* 右：マインドマップ */}
        <div className="relative flex-1">
          <div className="absolute inset-0 overflow-auto bg-neutral-50">
            <svg
              ref={svgRef}
              className="w-full h-full cursor-grab active:cursor-grabbing"
              viewBox={`${originX} ${originY} ${width} ${height}`}
              onMouseDown={onSvgMouseDown}
              onMouseMove={onSvgMouseMove}
              onMouseUp={onSvgMouseUp}
              onMouseLeave={onSvgMouseLeave}
            >
              <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
                {/* ツリーのリンク */}
                {treeRoot.links().map((l, idx: number) => {
                  const s = { x: (l.source as any).x as number, y: (l.source as any).y as number };
                  const t = { x: (l.target as any).x as number, y: (l.target as any).y as number };
                  const targetData = (l.target as any).data as RawNode;
                  const c = (targetData.effectiveColor || "#94a3b8") as string;
                  const visible = nodeMatches(targetData) && nodeMatches(((l.source as any).data as RawNode));
                  return (
                    <path
                      key={`link-${idx}`}
                      d={diagonal(s, t)}
                      fill="none"
                      stroke={c}
                      strokeOpacity={visible ? 0.5 : 0.12}
                      strokeWidth={1.5}
                    />
                  );
                })}

                {/* クロスリンク（ref） */}
                {crossLinks.map((cl, i) => (
                  <path
                    key={`xref-${i}`}
                    d={diagonal(cl.from, cl.to)}
                    fill="none"
                    strokeDasharray="4 3"
                    stroke={cl.color || "#ef4444"}
                    strokeOpacity={0.8}
                    strokeWidth={1.5}
                  />
                ))}

                {/* ノード */}
                {treeRoot.descendants().map((d, idx: number) => {
                  if ((d.data as RawNode).id === "root") return null; // ルートは非表示
                  const data = d.data as RawNode;
                  const color = data.effectiveColor || "#111827";
                  const selected = caretLine !== null && data.line === caretLine;
                  const matched = nodeMatches(data);
                  return (
                    <g
                      key={`node-${idx}`}
                      transform={`translate(${d.y},${d.x})`}
                      className="cursor-pointer"
                      onClick={() => onNodeClick(data)}
                      opacity={matched ? 1 : 0.25}
                    >
                      <circle r={selected ? 8 : 6} fill="#fff" stroke={color} strokeWidth={selected ? 3 : 2} />
                      <text x={10} y={4} fontSize={12} style={{ userSelect: "none" }} fill={color}>{data.text}</text>
                      {data.label && (<text x={10} y={18} fontSize={10} fill="#64748b">#{data.label}</text>)}
                      {data.pos && (<text x={-6} y={-10} fontSize={9} textAnchor="end" fill="#475569">[{data.pos}]</text>)}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </div>

        {/* エクスポート用の隠しSVG（常に全体を出力） */}
        <div style={{ position: 'absolute', left: -99999, top: -99999 }} aria-hidden="true">
          <svg
            ref={exportSvgRef}
            width={width}
            height={height}
            viewBox={`${originX} ${originY} ${width} ${height}`}
          >
            <g transform={`translate(0,0) scale(1)`}>
              {treeRoot.links().map((l, idx: number) => {
                const s = { x: (l.source as any).x as number, y: (l.source as any).y as number };
                const t = { x: (l.target as any).x as number, y: (l.target as any).y as number };
                const targetData = (l.target as any).data as RawNode;
                const c = (targetData.effectiveColor || "#94a3b8") as string;
                return (
                  <path key={`elink-${idx}`} d={diagonal(s, t)} fill="none" stroke={c} strokeOpacity={0.5} strokeWidth={1.5} />
                );
              })}
              {crossLinks.map((cl, i) => (
                <path key={`exref-${i}`} d={diagonal(cl.from, cl.to)} fill="none" strokeDasharray="4 3" stroke={cl.color || "#ef4444"} strokeOpacity={0.8} strokeWidth={1.5} />
              ))}
              {treeRoot.descendants().map((d, idx: number) => {
                if ((d.data as RawNode).id === "root") return null;
                const data = d.data as RawNode;
                const color = data.effectiveColor || "#111827";
                return (
                  <g key={`enode-${idx}`} transform={`translate(${d.y},${d.x})`}>
                    <circle r={6} fill="#fff" stroke={color} strokeWidth={2} />
                    <text x={10} y={4} fontSize={12} fill={color}>{data.text}</text>
                    {data.label && (<text x={10} y={18} fontSize={10} fill="#64748b">#{data.label}</text>)}
                    {data.pos && (<text x={-6} y={-10} fontSize={9} textAnchor="end" fill="#475569">[{data.pos}]</text>)}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      </div>

      {/* フッター：使い方 */}
      <div className="px-4 py-3 border-t bg-white text-xs text-neutral-600">
        <div className="font-semibold mb-1">使い方</div>
        <ul className="list-disc pl-5 space-y-1">
          <li>インデント（タブ or スペース2つ）で階層を作成します。</li>
          <li>色は <code>\\color</code>{'{#0ea5e9}'} または <code>\\color</code>{'{red}'} のように記述できます（プリセット: red, blue, green, orange, purple, teal, pink, gray, slate, amber, lime）。</li>
          <li><code>\\label</code>{'{name}'} で要素にラベルを付け、他の要素本文で <code>\\ref</code>{'{name}'} を使うとクロスリンク（破線）が描かれます（本文表示からは除去されます）。</li>
          <li>品詞は <code>\\pos</code>{'{noun|verb|adj|adv|prep|conj|pron|interj}'}、任意タグは <code>\\tags</code>{'{a,b}'} で付与できます。</li>
          <li>和訳は <code>\\jp</code>{'{日本語}' } を本文に追記します。右側のノードをクリックすると <strong>alert</strong> で <em>英語 → 日本語</em> が表示されます（例: <code>apple \\jp</code>{'{りんご}'}）。</li>
          <li>右側の図はマウスドラッグで移動できます。ズームは上部スライダーから。</li>
          <li>中央のバーをドラッグすると左右パネルの幅を変更できます。</li>
          <li>右上の「PDF出力」で右パネル全体をPDF保存できます。</li>
          <li>右側のノードをクリックすると、左のテキストの対応行を選択します。</li>
        </ul>
        {testResults && (
          <details className="mt-2">
            <summary className="cursor-pointer select-none">開発者向けセルフテスト（{testResults.filter(t=>t.ok).length}/{testResults.length} 成功）</summary>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              {testResults.map((t, i) => (
                <li key={i} className={t.ok ? "text-green-600" : "text-red-600"}>
                  {t.ok ? "✅" : "❌"} {t.name}{!t.ok && t.details ? ` - ${t.details}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
