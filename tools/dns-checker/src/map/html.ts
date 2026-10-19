import type { CompareReport } from '../core/compare.js';
import { MAP_CSS, MAP_SCRIPT } from './client.js';
import { WORLD_HEIGHT, WORLD_LAND_PATH, WORLD_WIDTH } from './world.js';

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function generateHtml(report: CompareReport): string {
  const data = { ...report, world: { width: WORLD_WIDTH, height: WORLD_HEIGHT } };
  const filter = (id: string, text: string, dot: string): string =>
    `<button id="f-${id}" type="button" aria-pressed="false">${dot ? `<span class="dot s-${id}"></span>` : ''}${text} <span class="n">0</span></button>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DNS map: ${escapeText(report.domain)}</title>
<style>${MAP_CSS}</style>
</head>
<body>
<header>
<div><h1>DNS results: <span id="title"></span></h1><div class="sub"><span id="ref"></span> &middot; <span id="gen"></span></div></div>
<div class="controls">
<select id="type" aria-label="Record type"></select>
${filter('all', 'All', '')}${filter('match', 'Match', 'x')}${filter('differ', 'Differ', 'x')}${filter('error', 'Error', 'x')}
</div>
</header>
<main>
<section class="card">
<h2>Map</h2>
<div id="mapwrap">
<svg id="map" viewBox="0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}" role="img" aria-label="World map of resolver results" preserveAspectRatio="xMidYMid meet"><path class="land" d="${WORLD_LAND_PATH}"></path><g id="markers"></g></svg>
<div class="zoom"><button id="zin" type="button" aria-label="Zoom in">+</button><button id="zout" type="button" aria-label="Zoom out">&minus;</button><button id="zreset" type="button" aria-label="Reset view">&#8962;</button></div>
</div>
</section>
<section>
<div class="card"><h2>Resolvers</h2><div class="tablewrap"><table><thead><tr><th>Resolver</th><th>Answer</th><th>Status</th><th>TTL</th></tr></thead><tbody id="tbody"></tbody></table></div></div>
<div class="card any" id="any" style="margin-top:14px"><h2>Anycast / no location</h2><div class="tablewrap"><table><tbody id="abody"></tbody></table></div></div>
</section>
</main>
<div id="tip" role="tooltip"></div>
<script id="data" type="application/json">${embedJson(data)}</script>
<script>${MAP_SCRIPT}</script>
</body>
</html>
`;
}
