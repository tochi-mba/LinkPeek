import {readFile,writeFile} from "node:fs/promises";
const read=async p=>JSON.parse(await readFile(p,"utf8"));
const [build,node,browser,release,install]=await Promise.all(["baseline/build.json","baseline/node.json","baseline/browser.json","baseline/release.json","baseline/install.json"].map(read));
const combined={generatedAt:new Date().toISOString(),commit:process.env.GITHUB_SHA||null,build,node,browser,release,install};
await writeFile("baseline/baseline.json",JSON.stringify(combined,null,2));
const b=build.artifacts,total=b.total,content=b.files["content.js"],bg=b.files["background.js"];
const lines=[
"# LinkPeek optimization baseline","",
`Commit: ${combined.commit||"local"}`,"",
"## Build & artifact",
`- Build: **${build.commands.build_ms} ms**`,
`- Typecheck: **${build.commands.typecheck_ms} ms**`,
`- Unit tests: **${build.commands.unit_tests_ms} ms**`,
`- Extension files: **${b.file_count}**`,
`- Extension raw size: **${total.raw} B**`,
`- Content script: **${content?.raw??0} B raw / ${content?.gzip??0} B gzip / ${content?.brotli??0} B brotli**`,
`- Background worker: **${bg?.raw??0} B raw / ${bg?.gzip??0} B gzip**`,
`- CRX: **${release.crx_bytes} B**`,"",
"## Browser latency",
`- Browser launch → service worker: **${browser.browser.launch_to_service_worker_ms} ms**`,
`- Navigation → content host: **${browser.browser.navigation_to_content_host_ms} ms**`,
`- Default hover → direct preview: **${browser.latency.default_hover_direct.result_ms} ms**`,
`- Direct preview, 0 ms hover: **${browser.latency.direct.result_ms} ms**`,
`- Generic 200 images: **${browser.latency.generic_200.result_ms} ms**`,
`- Generic 1000 images: **${browser.latency.generic_1000?.result_ms??"n/a"} ms**`,
`- Discourse 20 posts / 40 media: **${browser.latency.discourse_20_posts.result_ms} ms**`,
`- Discourse 100 posts / 200 media: **${browser.latency.discourse_100_posts.result_ms} ms**`,
`- Discourse 500 posts / 1000 media: **${browser.latency.discourse_500_posts.result_ms} ms**`,
`- Discourse 500 posts @ 100 ms RTT, first 40 media: **${browser.latency.discourse_500_posts_rtt100?.initial_ms??"n/a"} ms**`,
`- Discourse cache hit: **${browser.latency.discourse_20_posts_cache_hit_ms??browser.latency.discourse_500_posts_cache_hit_ms??"n/a"} ms**`,
`- Embedded fallback 100 posts: **${browser.latency.discourse_fallback_100_posts.result_ms} ms**`,
`- GIF hover → decoded controls: **${browser.latency.gif_hover_to_controls_ms} ms**`,"",
"## UI",
`- Grid render, 1000 media: **${browser.ui.grid_1000_render_ms} ms**`,
`- Gesture → next media (clean): **${browser.ui.gesture_clean_next_media_ms??browser.ui.gesture_next_media_ms??"n/a"} ms**`,
`- Gesture → next media after 1000-grid: **${browser.ui.gesture_after_grid_ms??"n/a"} ms**`,
`- 1000-grid thumbnail requests: **${browser.network.grid_1000?.requests??"n/a"} requests / ${browser.network.grid_1000?.response_bytes??"n/a"} B**`,
`- Default nearby prefetch (12 × 100-post threads): **${browser.network.default_nearby_prefetch_12_threads?.requests??"n/a"} requests / ${browser.network.default_nearby_prefetch_12_threads?.response_bytes??"n/a"} B in ${browser.network.default_nearby_prefetch_12_threads?.window_ms??"n/a"} ms**`,
`- 20 GIF frame steps: **${browser.ui.gif_20_frame_steps_ms} ms**`,
`- Options startup: **${browser.ui.options_startup_ms} ms**`,
`- Options search 'gif': **${browser.ui.options_search_gif_ms} ms**`,
`- Popup startup: **${browser.ui.popup_startup_ms} ms**`,
`- Onboarding startup: **${browser.ui.onboarding_startup_ms} ms**`,"",
"## Page heap deltas",
`- Large focus: **${browser.memory.deltas.large_focus_used} B**`,
`- 1000-item grid total retained: **${browser.memory.deltas.grid_1000_total_used??browser.memory.deltas.grid_1000_used} B**`,
`- 1000-item grid incremental over focus: **${browser.memory.deltas.grid_1000_incremental_used??"n/a"} B**`,
`- After close + GC: **${browser.memory.deltas.after_close_gc_used} B**`,
`- GIF decode: **${browser.memory.deltas.gif_decode_used} B**`,"",
"## CI/setup",
`- npm install: **${install.npm_install_ms} ms**`,
`- Chromium install: **${install.chromium_install_ms} ms**`,
`- Baseline workflow measured span: **${install.total_workflow_ms} ms**`,"",
"Full distributions, network bytes/request counts, bundle contribution data, and microbenchmarks are in baseline.json."
];
await writeFile("baseline/REPORT.md",lines.join("\n")+"\n");
console.log(lines.join("\n"));
