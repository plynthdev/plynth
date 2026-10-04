# Model jury (exception recommendations)

When a desk operation needs the board (PolicyGuard rule 9, `R9_APPROVAL`), the desk opens a
`BoardApprovals` ticket with a jury recommendation attached. The jury only advises. It holds no board key
and never calls `approve` or `reject`; only the board can make a ticket valid on-chain.

## Who sits on the jury

- **Rule juror** (always runs). It reruns the PolicyGuard arithmetic on the book as it would be after the
  operation: order and day caps, cash and equity bands (bit-for-bit `bandOk`), off-hours, and the drawdown
  pause and derisk levels. A ticket lifts rule 9 and nothing else, so if any other rule would still fail it
  recommends `reject`. Its output goes in the bundle separately, as `rules`.
- **Model jurors**: three small open models from different families, served by a local
  [Ollama](https://ollama.com) (free and open source). Each one is under 4 GB:

  | Model | Family | Size |
  |---|---|---|
  | `llama3.2:3b` | Meta Llama 3.2 | 2.0 GB |
  | `qwen2.5:3b` | Alibaba Qwen 2.5 | 1.9 GB |
  | `phi3.5` | Microsoft Phi-3.5 mini | 2.2 GB |

  Each model is called with `format: "json"`, `temperature: 0` and a fixed seed, and must answer
  `{recommend: approve|reject, confidence: 0..1, reasons: [..]}`. If the answer is invalid (bad JSON, wrong
  shape, an HTTP error or a timeout), the model gets one retry. A second failure means it abstains.

**Verdict**: the majority of the jurors that did not abstain. A tie, two or more abstentions, or no models
at all produce `none` (no recommendation).

If Ollama is not reachable, the service still works with the rule juror alone (`mode: "rules-only"`) and
logs that it fell back.

## The bundle

`{schema, mode, createdAt, request, models, jurors, verdict, rules, note}` is serialised as canonical JSON:
keys are sorted and bigints become strings. It is stored as-is in `jury_verdicts.bundle_json`, and its
`keccak256` goes on-chain as `BoardApprovals.request(opHash, juryVerdictCid)`. Anyone can re-derive the hash
from the stored text. The board API (`juryApi`, a fetch handler to mount under `/jury`) re-hashes every
bundle before serving it, and returns 409 if the hash no longer matches the stored hash or the ticket's
on-chain `juryVerdictCidOf`.

## Running it

```bash
brew install ollama
OLLAMA_HOST=127.0.0.1:11434 ollama serve &
ollama pull llama3.2:3b && ollama pull qwen2.5:3b && ollama pull phi3.5
```

The desk runner turns the jury on by default (`TREASURY_JURY=off` disables it). Environment variables:

- `OLLAMA_HOST` (default `http://127.0.0.1:11434`)
- `TREASURY_JURY_MODELS` (comma-separated; default: the three models above)
- `TREASURY_JURY_TIMEOUT_MS` (default 120000)

The desk files each opHash at most once per ticket TTL (24 h).
