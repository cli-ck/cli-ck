# Truncation Signaling for Call-Chain Traces

We decided to report a `truncated: bool` flag on call-chain trace results in cli-ck-code-intel, rather than building a full three-state (found / not-found / unknown) verdict, so a trace cut off by the BFS depth limit is distinguishable from one that genuinely terminates within it. This is a minimal, mechanical signal — it doesn't change how traces are computed, only how a depth-limited result is reported to a caller, and was scoped from a comparison against a competing code-intelligence tool.
