/**
 * mindmap.js — D3 force-directed mind map for PaperBrain
 *
 * Usage:
 *   const map = new MindMap('#mindmap-svg', { onOpenNote, onSavePosition, onCreateRelation });
 *   map.load(notes, relations, positions);
 *   map.resetLayout();
 *   map.filterByTag(tag);
 *   map.zoomIn(); map.zoomOut(); map.fitView();
 *   map.toggleRelationMode();
 *   map.exportSvg();
 *   map.getStats();
 *   map.destroy();
 *
 * Node types:
 *   - note  → circle, colored by primary tag
 *   - tag   → hexagon, larger
 *
 * Edges:
 *   - AI relation   → solid line, width ∝ score
 *   - manual        → dashed orange line
 *   - note→tag      → thin dotted (hidden by default, toggle with toggleTagLinks)
 */

/* global d3 */

const NOTE_R = 28;
const TAG_R  = 36;
const TAG_COLORS = [
  "#6366f1","#ec4899","#f59e0b","#10b981",
  "#3b82f6","#ef4444","#8b5cf6","#14b8a6",
  "#f97316","#06b6d4","#84cc16","#a855f7",
];

// How many px the pointer must move before a mousedown→mouseup is a drag
const DRAG_THRESHOLD = 5;

export class MindMap {
  constructor(svgSelector, opts = {}) {
    this.el = document.querySelector(svgSelector);
    if (!this.el) {
      console.warn("[MindMap] SVG element not found:", svgSelector);
      return;
    }
    this.opts = opts; // { onOpenNote, onSavePosition, onCreateRelation }
    this._showTagLinks  = false;
    this._filter        = null;
    this._sim           = null;
    this._nodes         = [];
    this._links         = [];
    this._tagLinks      = [];
    this._positions     = {};
    this._tagColorMap   = new Map();
    this._colorIdx      = 0;
    this._dragMoved     = 0;

    // Manual relation creation state
    this._relationMode   = false;
    this._relationSource = null; // node id string

    // Hover tooltip
    this._tooltip = document.createElement("div");
    this._tooltip.className = "mm-tooltip";
    this._tooltip.style.display = "none";
    document.body.appendChild(this._tooltip);

    this._svg = d3.select(this.el);
    this._g   = this._svg.append("g").attr("class", "mm-root");

    this._zoom = d3.zoom()
      .scaleExtent([0.1, 6])
      .on("zoom", (e) => this._g.attr("transform", e.transform));
    this._svg.call(this._zoom);
    this._svg.on("dblclick.zoom", null);

    // Background click: cancel relation-mode source selection
    this._svg.on("click.bg", (e) => {
      if (e.target === this.el || e.target.tagName === "svg") {
        this._cancelRelationSource();
      }
    });
  }

  // ── Color helpers ────────────────────────────────────────────

  _tagColor(tag) {
    if (!this._tagColorMap.has(tag)) {
      this._tagColorMap.set(tag, TAG_COLORS[this._colorIdx % TAG_COLORS.length]);
      this._colorIdx++;
    }
    return this._tagColorMap.get(tag);
  }

  // ── Data loading ─────────────────────────────────────────────

  load(notes, relations, positions) {
    this._rawNotes     = notes;
    this._rawRelations = relations;
    this._positions    = {};
    for (const p of positions) {
      this._positions[`${p.node_type}:${p.node_id}`] = { x: p.x, y: p.y };
    }
    this._build();
  }

  _build() {
    const notes     = this._rawNotes     ?? [];
    const relations = this._rawRelations ?? [];

    const tagSet = new Set();
    for (const n of notes) (n.tags ?? []).forEach((t) => tagSet.add(t));

    this._nodes = [
      ...notes.map((n) => ({
        id:      `note:${n.id}`,
        type:    "note",
        noteId:  n.id,
        label:   n.title   ?? "Untitled",
        summary: n.summary ?? "",
        tags:    n.tags    ?? [],
        color:   this._tagColor((n.tags ?? [])[0] ?? "_default"),
        r:       NOTE_R,
        fx:      this._positions[`note:${n.id}`]?.x ?? null,
        fy:      this._positions[`note:${n.id}`]?.y ?? null,
      })),
      ...[...tagSet].map((tag) => ({
        id:    `tag:${tag}`,
        type:  "tag",
        tag,
        label: `#${tag}`,
        color: this._tagColor(tag),
        r:     TAG_R,
        fx:    this._positions[`tag:${tag}`]?.x ?? null,
        fy:    this._positions[`tag:${tag}`]?.y ?? null,
      })),
    ];

    this._links = relations
      .filter((r) => r.from_id && r.to_id)
      .map((r) => ({
        source: `note:${r.from_id}`,
        target: `note:${r.to_id}`,
        score:  r.score ?? 0.5,
        manual: r.manual,
        reason: r.reason ?? "",
        id:     r.id,
      }));

    this._tagLinks = [];
    for (const n of notes) {
      for (const tag of (n.tags ?? [])) {
        this._tagLinks.push({
          source:     `note:${n.id}`,
          target:     `tag:${tag}`,
          isTagLink:  true,
        });
      }
    }

    this._render();
  }

  // ── Render ───────────────────────────────────────────────────

  _render() {
    if (!this.el) return;
    const W = this.el.clientWidth  || 800;
    const H = this.el.clientHeight || 600;

    if (this._sim) this._sim.stop();
    this._g.selectAll("*").remove();

    // ── Empty state ─────────────────────────────────────────────
    const notes = this._rawNotes ?? [];
    if (!notes.length) {
      this._g.append("text")
        .attr("x", W / 2).attr("y", H / 2 - 18)
        .attr("text-anchor", "middle").attr("fill", "#94a3b8")
        .attr("font-size", 18).attr("font-weight", "600")
        .text("No notes yet");
      this._g.append("text")
        .attr("x", W / 2).attr("y", H / 2 + 14)
        .attr("text-anchor", "middle").attr("fill", "#64748b")
        .attr("font-size", 13)
        .text("Upload handwritten notes to build your mind map.");
      return;
    }

    const allLinks = this._showTagLinks
      ? [...this._links, ...this._tagLinks]
      : this._links;

    // ── Filter: dim non-matching, don't hide ────────────────────
    const filterLc  = this._filter?.toLowerCase() ?? "";
    const hasFilter = filterLc.length > 0;
    const matchesFilter = (n) => {
      if (!hasFilter) return true;
      if (n.type === "tag")  return n.tag.toLowerCase().includes(filterLc);
      return (n.tags ?? []).some((t) => t.toLowerCase().includes(filterLc));
    };

    const visibleNodes = this._nodes;
    const visibleLinks = allLinks.filter((l) => {
      const sid = typeof l.source === "object" ? l.source.id : l.source;
      const tid = typeof l.target === "object" ? l.target.id : l.target;
      const sn  = this._nodes.find((n) => n.id === sid);
      const tn  = this._nodes.find((n) => n.id === tid);
      return sn && tn;
    });

    // ── Arrow marker (userSpaceOnUse → fixed size regardless of stroke) ──
    const defs = this._g.append("defs");
    defs.append("marker")
      .attr("id", "mm-arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 10)
      .attr("refY", 0)
      .attr("markerWidth",  8)
      .attr("markerHeight", 8)
      .attr("markerUnits", "userSpaceOnUse")
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#94a3b8");

    // Highlighted arrow for relation-mode hover
    defs.append("marker")
      .attr("id", "mm-arrow-manual")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 10)
      .attr("refY", 0)
      .attr("markerWidth",  8)
      .attr("markerHeight", 8)
      .attr("markerUnits", "userSpaceOnUse")
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#f59e0b");

    // ── Links layer ─────────────────────────────────────────────
    const linkG = this._g.append("g").attr("class", "mm-links");
    this._linkEl = linkG.selectAll("line")
      .data(visibleLinks)
      .join("line")
      .attr("class", "mm-link")
      .attr("stroke", (d) =>
        d.isTagLink ? "#94a3b855"
        : d.manual  ? "#f59e0b"
        :              "#94a3b8")
      .attr("stroke-width", (d) =>
        d.isTagLink ? 1 : Math.max(1.5, (d.score ?? 0.5) * 4))
      .attr("stroke-dasharray", (d) =>
        d.manual ? "6 3" : d.isTagLink ? "2 4" : null)
      .attr("marker-end", (d) => {
        if (d.isTagLink) return null;
        return d.manual ? "url(#mm-arrow-manual)" : "url(#mm-arrow)";
      })
      .attr("opacity", (d) => {
        if (!hasFilter) return 1;
        const sid = typeof d.source === "object" ? d.source.id : d.source;
        const tid = typeof d.target === "object" ? d.target.id : d.target;
        const sn  = this._nodes.find((n) => n.id === sid);
        const tn  = this._nodes.find((n) => n.id === tid);
        return (matchesFilter(sn) && matchesFilter(tn)) ? 1 : 0.08;
      });

    this._linkEl.append("title").text((d) => d.reason || "");

    // ── Nodes layer ─────────────────────────────────────────────
    const nodeG = this._g.append("g").attr("class", "mm-nodes");
    this._nodeEl = nodeG.selectAll("g.mm-node")
      .data(visibleNodes)
      .join("g")
      .attr("class", "mm-node")
      .attr("cursor", (d) => this._relationMode && d.type === "note" ? "crosshair" : "pointer")
      .attr("opacity", (d) => hasFilter ? (matchesFilter(d) ? 1 : 0.18) : 1)
      .call(
        d3.drag()
          .on("start", (e, d) => this._onDragStart(e, d))
          .on("drag",  (e, d) => this._onDrag(e, d))
          .on("end",   (e, d) => this._onDragEnd(e, d)),
      )
      .on("click",      (e, d) => this._onClick(e, d))
      .on("mouseenter", (e, d) => this._onHover(e, d))
      .on("mousemove",  (e)    => this._moveTooltip(e))
      .on("mouseleave", ()     => this._hideTooltip());

    // Note → circle; Tag → hexagon
    this._nodeEl.each(function(d) {
      const el = d3.select(this);
      if (d.type === "note") {
        el.append("circle")
          .attr("r", d.r)
          .attr("fill",         d.color + "cc")
          .attr("stroke",       d.color)
          .attr("stroke-width", 2);
      } else {
        el.append("polygon")
          .attr("points",       _hexPoints(d.r))
          .attr("fill",         d.color + "99")
          .attr("stroke",       d.color)
          .attr("stroke-width", 2.5);
      }
    });

    // Labels (two-line for multi-word note titles)
    this._nodeEl.append("text")
      .attr("text-anchor",   "middle")
      .attr("dy",            "0.35em")
      .attr("font-size",     (d) => d.type === "tag" ? 12 : 10)
      .attr("font-weight",   (d) => d.type === "tag" ? "bold" : "normal")
      .attr("fill",          "#f8fafc")
      .attr("pointer-events", "none")
      .each(function(d) {
        const words = d.label.split(/\s+/);
        const el    = d3.select(this);
        if (words.length <= 2 || d.type === "tag") {
          el.text(d.label.length > 18 ? d.label.slice(0, 16) + "…" : d.label);
        } else {
          const line1 = words.slice(0, 2).join(" ");
          const line2 = words.slice(2).join(" ");
          el.append("tspan").attr("x", 0).attr("dy", "-0.6em").text(line1.slice(0, 16));
          el.append("tspan").attr("x", 0).attr("dy",  "1.2em").text(
            line2.slice(0, 16) + (line2.length > 16 ? "…" : ""),
          );
        }
      });

    // ── Simulation ──────────────────────────────────────────────
    this._sim = d3.forceSimulation(visibleNodes)
      .force("link",    d3.forceLink(visibleLinks).id((d) => d.id).distance(130).strength(0.35))
      .force("charge",  d3.forceManyBody().strength(-320))
      .force("center",  d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide((d) => d.r + 12))
      .alphaDecay(0.028)
      .on("tick", () => this._tick());
  }

  _tick() {
    if (!this._linkEl || !this._nodeEl) return;

    this._linkEl
      .attr("x1", (d) => _edgePt(d.source, d.target, true,  false))
      .attr("y1", (d) => _edgePt(d.source, d.target, true,  true))
      .attr("x2", (d) => _edgePt(d.source, d.target, false, false))
      .attr("y2", (d) => _edgePt(d.source, d.target, false, true));

    this._nodeEl.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
  }

  // ── Drag ─────────────────────────────────────────────────────

  _onDragStart(e, d) {
    if (!e.active) this._sim.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
    this._dragMoved = 0;
    this._hideTooltip();
  }

  _onDrag(e, d) {
    d.fx = e.x;
    d.fy = e.y;
    this._dragMoved += Math.abs(e.dx) + Math.abs(e.dy);
  }

  _onDragEnd(e, d) {
    if (!e.active) this._sim.alphaTarget(0);
    d.fx = d.x;
    d.fy = d.y;
    if (this._dragMoved > DRAG_THRESHOLD) {
      const [nodeType, ...rest] = d.id.split(":");
      const nodeId = rest.join(":");
      this.opts.onSavePosition?.({ nodeType, nodeId, x: d.x, y: d.y });
    }
  }

  // ── Click (only fires when drag distance is below threshold) ──

  _onClick(e, d) {
    e.stopPropagation();
    if (this._dragMoved > DRAG_THRESHOLD) return;

    // ── Relation-creation mode ──────────────────────────────────
    if (this._relationMode && d.type === "note") {
      if (!this._relationSource) {
        this._relationSource = d.id;
        this._updateRelationHighlight();
      } else if (this._relationSource !== d.id) {
        const fromId = this._relationSource.replace(/^note:/, "");
        const toId   = d.noteId;
        this._relationSource = null;
        this._updateRelationHighlight();
        this.opts.onCreateRelation?.({ fromId, toId });
      }
      return;
    }

    if (d.type === "note") {
      this.opts.onOpenNote?.(d.noteId);
    } else if (d.type === "tag") {
      const newFilter = d.tag === this._filter ? null : d.tag;
      this.filterByTag(newFilter);
    }
  }

  // ── Tooltip ──────────────────────────────────────────────────

  _onHover(e, d) {
    if (this._dragMoved > 0) return;
    const parts = [`<strong>${_esc(d.label)}</strong>`];
    if (d.type === "note" && d.summary) {
      const preview = d.summary.length > 140
        ? d.summary.slice(0, 138) + "…"
        : d.summary;
      parts.push(`<span>${_esc(preview)}</span>`);
    }
    if (d.type === "note" && d.tags?.length) {
      parts.push(`<span class="mm-tooltip-tags">${d.tags.map((t) => `#${_esc(t)}`).join(" ")}</span>`);
    }
    if (d.type === "tag") {
      const count = (this._rawNotes ?? []).filter((n) => (n.tags ?? []).includes(d.tag)).length;
      parts.push(`<span>${count} note${count !== 1 ? "s" : ""}</span>`);
    }
    this._tooltip.innerHTML = parts.join("<br>");
    this._tooltip.style.display = "block";
    this._moveTooltip(e);
  }

  _moveTooltip(e) {
    if (this._tooltip.style.display === "none") return;
    const x = e.clientX + 16;
    const y = e.clientY - 10;
    this._tooltip.style.left = x + "px";
    this._tooltip.style.top  = y + "px";
  }

  _hideTooltip() {
    this._tooltip.style.display = "none";
  }

  // ── Relation-mode highlight ──────────────────────────────────

  _cancelRelationSource() {
    if (this._relationSource) {
      this._relationSource = null;
      this._updateRelationHighlight();
    }
  }

  _updateRelationHighlight() {
    if (!this._nodeEl) return;
    this._nodeEl.selectAll("circle, polygon")
      .attr("stroke", (d) =>
        this._relationMode && d.id === this._relationSource ? "#facc15" : d.color)
      .attr("stroke-width", (d) => {
        if (this._relationMode && d.id === this._relationSource) return 4;
        return d.type === "note" ? 2 : 2.5;
      });
  }

  // ── Public API ──────────────────────────────────────────────

  resetLayout() {
    for (const n of this._nodes) { n.fx = null; n.fy = null; }
    this._render();
  }

  filterByTag(tag) {
    this._filter = tag ?? null;
    if (!this._nodeEl) { this._render(); return; }
    // Fast-path: just update opacity without rebuilding simulation
    const filterLc  = this._filter?.toLowerCase() ?? "";
    const hasFilter = filterLc.length > 0;
    const matchesFilter = (n) => {
      if (!hasFilter) return true;
      if (n.type === "tag")  return n.tag.toLowerCase().includes(filterLc);
      return (n.tags ?? []).some((t) => t.toLowerCase().includes(filterLc));
    };
    this._nodeEl.attr("opacity", (d) => hasFilter ? (matchesFilter(d) ? 1 : 0.18) : 1);
    this._linkEl?.attr("opacity", (d) => {
      if (!hasFilter) return 1;
      const sid = typeof d.source === "object" ? d.source.id : d.source;
      const tid = typeof d.target === "object" ? d.target.id : d.target;
      const sn  = this._nodes.find((n) => n.id === sid);
      const tn  = this._nodes.find((n) => n.id === tid);
      return (sn && tn && matchesFilter(sn) && matchesFilter(tn)) ? 1 : 0.08;
    });
  }

  toggleTagLinks() {
    this._showTagLinks = !this._showTagLinks;
    this._render();
  }

  toggleRelationMode() {
    this._relationMode   = !this._relationMode;
    this._relationSource = null;
    this._updateRelationHighlight();
    if (this._nodeEl) {
      this._nodeEl.attr("cursor",
        (d) => this._relationMode && d.type === "note" ? "crosshair" : "pointer");
    }
    return this._relationMode;
  }

  zoomIn() {
    this._svg.transition().duration(220).call(this._zoom.scaleBy, 1.4);
  }

  zoomOut() {
    this._svg.transition().duration(220).call(this._zoom.scaleBy, 1 / 1.4);
  }

  fitView() {
    if (!this._nodes.length || !this.el) return;
    const W   = this.el.clientWidth  || 800;
    const H   = this.el.clientHeight || 600;
    const xs  = this._nodes.map((n) => n.x).filter((v) => v != null);
    const ys  = this._nodes.map((n) => n.y).filter((v) => v != null);
    if (!xs.length) return;
    const pad  = TAG_R * 2.5;
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    const scale = Math.min(1, 0.92 * Math.min(W / (maxX - minX), H / (maxY - minY)));
    const tx    = W / 2 - scale * (minX + maxX) / 2;
    const ty    = H / 2 - scale * (minY + maxY) / 2;
    this._svg.transition().duration(420)
      .call(this._zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  getStats() {
    const noteCount = (this._rawNotes     ?? []).length;
    const linkCount = (this._rawRelations ?? []).length;
    const tagCount  = new Set(
      (this._rawNotes ?? []).flatMap((n) => n.tags ?? []),
    ).size;
    return { notes: noteCount, tags: tagCount, links: linkCount };
  }

  exportSvg() {
    if (!this.el) return;
    const serializer = new XMLSerializer();
    // Add a background rect so the export has the dark fill
    const clone = this.el.cloneNode(true);
    const bg    = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("width",  "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill",   "#0d1117");
    clone.insertBefore(bg, clone.firstChild);
    const svgStr = serializer.serializeToString(clone);
    const blob   = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url    = URL.createObjectURL(blob);
    const a      = Object.assign(document.createElement("a"), {
      href:     url,
      download: `paperbrain-mindmap-${Date.now()}.svg`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  destroy() {
    if (this._sim) this._sim.stop();
    this._g.selectAll("*").remove();
    this._tooltip?.remove();
    this._tooltip = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function _hexPoints(r) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    return `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
  }).join(" ");
}

/**
 * Compute the x or y coordinate of the link endpoint on the node's edge.
 * Lines go from the circumference of source to the circumference of target
 * so arrows land exactly at the node boundary.
 */
function _edgePt(src, tgt, isSource, returnY) {
  const dx  = (tgt.x ?? 0) - (src.x ?? 0);
  const dy  = (tgt.y ?? 0) - (src.y ?? 0);
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const node = isSource ? src : tgt;
  const sign = isSource ? 1 : -1;
  return returnY
    ? (node.y ?? 0) + sign * (dy / len) * node.r
    : (node.x ?? 0) + sign * (dx / len) * node.r;
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
