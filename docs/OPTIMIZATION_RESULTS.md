# LinkPeek Optimization Results

This branch exists to verify the already-merged runtime optimization currently on `main` using the permanent optimization benchmark workflow.

The runtime code on this branch is identical to `main`.

Verification goals:
- local 500-post Discourse completion should remain near the optimized phase-1 range
- 50 ms RTT full scan should remain under 350 ms
- 100 ms RTT full scan should remain under 600 ms
- first usable media at 100 ms RTT should remain under 180 ms
- 1,000-item grid should render under 50 ms with fewer than 60 initial thumbnails
- Nearby prefetch should remain under 15 requests / 150 KB for the benchmark fixture
- content script should remain under 30 KB raw
- all normal correctness checks and CRX packaging must pass

Final measured values will be added after the verification run completes.
