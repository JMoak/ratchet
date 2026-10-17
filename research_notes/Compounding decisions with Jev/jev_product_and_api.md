# TypeSafe AI "Jev" (System One Model): product and API engineering notes

All facts captured 2026-10-15 unless a different capture date is stated. "Official" means TypeSafe's own docs, blog, legal pages or console; everything else is marked third-party. Raw copies of the official docs pages used here (fetched 2026-10-15 from `https://docs.typesafe.ai/<page>.md`) are in `C:\Users\moakj\AppData\Local\Temp\claude\C--src\004b9828-a037-4bad-91b7-f3cfffd42c9c\scratchpad\typesafe_docs\`.

Documentation index (official, lists every docs page): https://docs.typesafe.ai/llms.txt

---

## Key Question 1: Exact HTTP request and response JSON for each primitive (Choice, Score, Noul, plus the new Box)

### Takeaway
One endpoint (`POST https://api.typesafe.ai/v1/systemone`, Bearer auth) takes `{state, model, questions}` where `questions` is a map of caller-chosen ids to typed question objects; the response is `{model, answers, usage}` with one typed answer per id. Choice returns `choice` + `probabilities` + `confidence`, Score returns `score` + `legend` + `probabilities` + `confidence`, Noul returns a single `noul` probability with no separate confidence. All JSON below is quoted verbatim from the official API reference.

### Cited Findings

**Endpoint and auth (official, verbatim)**
- ```http
  POST https://api.typesafe.ai/v1/systemone
  Authorization: Bearer <API_KEY>
  Content-Type: application/json
  ``` — [TypeSafe API reference](https://docs.typesafe.ai/api)
- Request body fields (official): `state` — `string | object | array`, required: "The content to evaluate. A plain string for text, or structured data (object/array) for things like chat logs, records, or the current state of your application." `model` — `string`, required: "The model that handles the request. Use `\"jev-latest\"`, TypeSafe's flagship model." `questions` — `map<string, Question>`, required: "A map of typed Question objects. You choose each key; answers come back under the same keys." Per entry: "The key is not sent to the underlying model and is not used in inference." — [API reference](https://docs.typesafe.ai/api)
- Verbatim example request (official):
  ```json
  {
    "state": "Help! My payouts have been failing for 3 days.",
    "model": "jev-latest",
    "questions": {
      "is_urgent": {
        "type": "noul",
        "instructions": "Does this convey urgency?"
      }
    }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Verbatim example response (official):
  ```json
  {
    "model": "jev-1.13.0",
    "answers": {
      "is_urgent": {
        "type": "noul",
        "noul": 0.95
      }
    },
    "usage": { "input_tokens": 296, "output_tokens": 20 }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Response fields (official): `model` (string, required) "The model that performed the evaluation." `answers` (`map<string, Answer>`, required). `usage` (object, required) with `input_tokens` (integer) and `output_tokens` (integer). — [API reference](https://docs.typesafe.ai/api)
- "Every answer carries a `type` matching its question. Some answer types also carry a `confidence` between 0 and 1" — [API reference](https://docs.typesafe.ai/api)
- `instructions` on every question type "can be a string, an object, or an array"; verbatim structured example from the API reference:
  ```json
  "instructions": {
    "potential_duplicate": {
      "name": "John Smith",
      "location": "Oakland, California",
      "last_employer": "Google"
    },
    "question": "Is the resume for the same person as `potential_duplicate`?"
  }
  ``` — [API reference](https://docs.typesafe.ai/api)

**Noul (official, verbatim)**
- Fields: `type` = `"noul"` (required); `instructions` `string | object | array` (required) "The yes/no question to evaluate"; `criteria` `object` (optional) "Optional descriptions of what a yes and a no mean" with properties `true` (`string | object | array`, "What a yes (value near 1) means") and `false` (`string | object | array`, "What a no (value near 0) means"). — [API reference](https://docs.typesafe.ai/api)
- Verbatim request:
  ```json
  {
    "state": "Help! My payouts have been failing for 3 days.",
    "model": "jev-latest",
    "questions": {
      "is_urgent": {
        "type": "noul",
        "instructions": "Does this convey urgency?",
        "criteria": {
          "true": "Explicitly time-sensitive",
          "false": "No urgency expressed"
        }
      }
    }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Noul answer: `type` = `"noul"`; `noul` (number, required) "The yes/no answer on a scale from 0 (no) to 1 (yes)." Verbatim response:
  ```json
  {
    "model": "jev-1.13.0",
    "answers": {
      "is_urgent": {
        "type": "noul",
        "noul": 0.95
      }
    },
    "usage": { "input_tokens": 307, "output_tokens": 20 }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- "There is no separate `confidence` value for a Noul, unlike a Choice or a Score. A Noul's probability distribution has only two outcomes, yes and no, so the single `noul` value describes it completely." — [Noul page](https://docs.typesafe.ai/primitives/noul)
- Multi-Noul verbatim response (two questions, structured `criteria`):
  ```json
  {
    "model": "jev-1.13.0",
    "answers": {
      "is_human_escalation": { "type": "noul", "noul": 0.99 },
      "is_repeat_contact": { "type": "noul", "noul": 0.93 }
    },
    "usage": { "input_tokens": 360, "output_tokens": 39 }
  }
  ``` — [Noul page](https://docs.typesafe.ai/primitives/noul)

**Choice (official, verbatim)**
- Fields: `type` = `"choice"` (required); `instructions` `string | object | array` (required); `criteria` `map<string, string | object | array | null>` (required): "A map of option to rubric description; use null when an option needs no extra detail. You can have a maximum of 255 options per Choice." — [API reference](https://docs.typesafe.ai/api)
- Verbatim request:
  ```json
  {
    "state": "Help! My payouts have been failing for 3 days.",
    "model": "jev-latest",
    "questions": {
      "department": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {
          "billing": "Payments, invoicing, refunds",
          "technical": "Bugs, outages, integrations",
          "sales": "Pricing, upgrades, new accounts"
        }
      }
    }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Choice answer: `type` = `"choice"`; `choice` (string, required) "The highest-probability option."; `probabilities` (`map<string, number>`, required) "Every option mapped to its probability (floats that sum to 1)."; `confidence` (number, required) "How certain the model is, derived from probabilities." Verbatim response:
  ```json
  {
    "model": "jev-1.13.0",
    "answers": {
      "department": {
        "type": "choice",
        "choice": "billing",
        "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
        "confidence": 0.81
      }
    },
    "usage": { "input_tokens": 318, "output_tokens": 34 }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Option names AND descriptions are both sent to the model ("The model never sees the question id. The option names and their descriptions are both sent to the model, so write descriptions that separate the options from each other."); `null` descriptions are allowed when names are self-explanatory (`criteria: { calm: null, frustrated: null, angry: null }`). — [Choice page](https://docs.typesafe.ai/primitives/choice)
- Five-question Choice example response (verbatim, shows per-question confidence down to 0.2 and keys returned in arbitrary order):
  ```json
  "department": { "type": "choice", "choice": "returns", "confidence": 0.42,
    "probabilities": { "shipping": 0.04, "billing": 0.35, "returns": 0.61 } },
  "requested_resolution": { "type": "choice", "choice": "refund", "confidence": 0.2,
    "probabilities": { "replacement": 0.34, "refund": 0.4, "information": 0.02, "exchange": 0.24 } }
  ```
  with `"usage": { "input_tokens": 589, "output_tokens": 212 }` — [Choice page](https://docs.typesafe.ai/primitives/choice)
- Structured criteria example (field names `question`, `focus`, `what`, `not_for`, `examples` "are not part of the API, and none are reserved. You choose them... The model sees the names along with the values") — [Choice page](https://docs.typesafe.ai/primitives/choice)
- "Add an `other` or `none of the above` option when the list might not cover every input" — [Choice page](https://docs.typesafe.ai/primitives/choice)

**Score (official, verbatim)**
- Fields: `type` = `"score"` (required); `instructions` (required); `criteria` `array<string | object | array>` (required): "An ordered array of level descriptions. A Score should have at least two levels; the API accepts up to 10." — [API reference](https://docs.typesafe.ai/api)
- Verbatim request:
  ```json
  {
    "state": "Help! My payouts have been failing for 3 days.",
    "model": "jev-latest",
    "questions": {
      "frustration": {
        "type": "score",
        "instructions": "How frustrated is the customer?",
        "criteria": ["Calm", "Frustrated", "Very angry"]
      }
    }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Score answer: `type` = `"score"`; `score` (number, required) "The probability-weighted answer across the levels; can land between levels."; `legend` (`map<string, string>`, required) "Each level number mapped back to its description."; `probabilities` (`map<string, number>`, required) "Each level (string key) mapped to its probability (floats that sum to 1)."; `confidence` (number, required). Verbatim response:
  ```json
  {
    "model": "jev-1.13.0",
    "answers": {
      "frustration": {
        "type": "score",
        "score": 1.05,
        "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
        "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
        "confidence": 0.92
      }
    },
    "usage": { "input_tokens": 304, "output_tokens": 18 }
  }
  ``` — [API reference](https://docs.typesafe.ai/api)
- Level numbering: "A level's number is its position in the `criteria` array, starting at 0 ... The order of the array is the numbering." Score "runs from 0 to 2 [for 3 levels], and it can land between two levels." Worked example: probabilities (0.0, 0.57, 0.43) → score 0 x 0.0 + 1 x 0.57 + 2 x 0.43 = 1.43, confidence 0.35. — [Score page](https://docs.typesafe.ai/primitives/score)
- When `criteria` entries are objects, `legend` echoes the objects verbatim (response shows `"legend": { "0": { "what": "...", "examples": [...] }, ... }`). — [Score page](https://docs.typesafe.ai/primitives/score)
- "The model gets the descriptions and nothing else, and each level is judged on its own against the state." Numeric-only levels fail: `criteria: ["0","1","2"]` on a cosmetic bug → score 0.55, confidence 0.33 vs descriptive levels → 0.0 at confidence 1.0. — [Score page](https://docs.typesafe.ai/primitives/score)
- Python SDK note: "The SDK keys `probabilities` and `legend` by integer level rather than by string." — [Score page](https://docs.typesafe.ai/primitives/score)

**Box (official, experimental, Jev 1.14 only)**
- Box "is a System One question type for finding where something is in an image"; fields `type: "box"`, `instructions`; "Box takes no `criteria`"; "Box questions need Jev 1.14: send `jev-preview` or `jev-1.14.0` as the `model`"; requires header `TypeSafe-Danger-Zone-Images: true`. Verbatim response:
  ```json
  {
    "model": "jev-1.14.0",
    "answers": {
      "mug": {
        "type": "box",
        "box": { "top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84 },
        "confidence": 0.92
      }
    },
    "usage": {"input_tokens": 290, "output_tokens": 21}
  }
  ```
  "A Box answer is always a box. There is no 'not found' answer" (pair with a Noul). Marked "Dreamer-ready ... request format, the answers, and the limits on this page can change between releases." — [Box page](https://docs.typesafe.ai/primitives/box)
- Image request uses `multipart/form-data` with a `request` JSON part containing `"assets": {"<ref>": {"type": "image", "part": "<part-name>"}}` and references in `state`/`instructions`/`criteria`; images are a "Clef extension"-style opt-in via header. — [Box page](https://docs.typesafe.ai/primitives/box); [Images page](https://docs.typesafe.ai/images)
- Image limits (official): PNG or JPEG only (animated PNG rejected); 16 MiB per image file; width and height each 280 to 1568 px; total pixels 78,400 to 2,458,624; request body 32 MiB; all images after processing 32 MiB; "expanded request" 32 MiB where each reference re-adds the image; reference keys at most 1,024 bytes each and 65,536 bytes total; rejected images fail the whole request. — [Images page](https://docs.typesafe.ai/images)

**Request rules, compression, errors (official, verbatim table)**
- | Rule | Limit | — Body size: "At most 32 MiB. Headers don't count." Encoding: "UTF-8 JSON without a byte order mark (BOM)." Nesting: "At most 64 nested levels of objects and arrays in each of `state`, `instructions`, and `criteria`." Numbers: "Finite numbers only. `NaN`, `Infinity`, and numbers too large to represent, such as `1e400`, are rejected. Send identifiers and exact large quantities as strings." "A body over 32 MiB returns `413`; the other rules return `400`." — [API reference](https://docs.typesafe.ai/api)
- Compression: "`Content-Encoding: gzip` (or `x-gzip`) or `zstd`. The SDKs compress request bodies of 1 KiB or more with zstd when the runtime supports it. Use one compression layer, and keep zstd's window at most 8 MiB. The 32 MiB limit applies to both the compressed and the decompressed body. An unsupported `Content-Encoding` or more than one layer returns `415`; a malformed compressed body returns `400`." — [API reference](https://docs.typesafe.ai/api)
- Errors: `400 Bad Request` (request-rule violation; "With `max_tokens_exceeded`, the request is longer than the model's context length"); `401 Unauthorized`; `413 Payload Too Large`; `415 Unsupported Media Type`; `422 Unprocessable Entity` ("The request body failed validation, for example a missing required field or a malformed question. The body details the offending field."); `429 Too Many Requests`; `529 Overloaded`. "When you receive a `429` ... or `529` ... retry the request with exponential backoff." — [API reference](https://docs.typesafe.ai/api)
- Error body shape as relayed by Vercel's TypeSafe-compatible surface: `{"message": "questions.refund.type: expected one of 'noul', 'choice', 'score'", "error_type": "invalid_request"}` (Vercel says "Errors use TypeSafe's shape"). — [Vercel TypeSafe API docs](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
- Response header `x-typesafe-request-id` exists (Python SDK exposes it as `request_id`). — [Python SDK exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions)
- Models listing endpoint: `GET https://api.typesafe.ai/v1/models` returns `{"models": [{"name", "description", "release_date"}]}`; "It currently lists the aliases. Versioned IDs such as `jev-1.14.0` are accepted by the `model` field whether or not they appear in the list." — [Models page](https://docs.typesafe.ai/models)

**Semantics an adapter must respect (official)**
- "Jev ingests the `state` once and evaluates every question against it in parallel." "All questions see the same state and are evaluated independently." "Questions in the same request are independent: one answer does not become context for another question. If a later judgment depends on an earlier answer, make a second request in code." — [Models](https://docs.typesafe.ai/models); [State](https://docs.typesafe.ai/concepts/state); [Primitives](https://docs.typesafe.ai/primitives)
- "There is no limit on the number of questions in a request. What limits a request is its size" (both context limits). — [Primitives](https://docs.typesafe.ai/primitives)
- `state` shapes: string, object, or array; "Use an object for most requests"; reference nested values from instructions with backticked dot/index paths such as `` `support.tickets[0].message` ``. — [State](https://docs.typesafe.ai/concepts/state); [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- `instructions`, Choice option descriptions, Score level descriptions, and Noul `criteria.true/false` all accept `string`, `object`, `array`, or `null` ("Every one of these fields is an `EntryType`"). — [Advanced: structure](https://docs.typesafe.ai/primitives/advanced)
- Order of keys in `probabilities` in responses is not stable (examples show `{"shipping","billing","returns"}` vs `{"shipping","returns","billing"}`). — [Choice page](https://docs.typesafe.ai/primitives/choice)

### Inferences
- An adapter should treat `answers` as a map keyed by its own ids, never positional; validate `type` on each answer; for Score convert string level keys to ints; never assume `probabilities` key order; treat `confidence` as optional-per-type (absent on Noul, present on Choice/Score/Box).
- Because ids are never sent to the model, ids can safely encode routing metadata (e.g. `same_as_record_42`) as the docs do.
- 255 options x "a few tokens each" plus the 32k per-question limit means very wide Choices are allowed but should be budgeted in tokens; the launch blog mentions a two-stage process for cardinality above 255.

### Gaps
- The docs do not state numeric precision of returned probabilities (examples show two decimals; Vercel's AI SDK exposes a `result.rounding` field "reports the two-decimal rounding precision", suggesting values are rounded to 2 dp). Unverified against the raw API.
- No official statement on whether Choice `probabilities` for a 1-option Choice are valid (Vercel's SDK says 1–255 options; TypeSafe's docs say "at least two" only for Score).
- No documented JSON schema file (OpenAPI) was found on docs.typesafe.ai.

---

## Key Question 2: Model identifiers, versioning, pricing, latency, batching, context limits

### Takeaway
Two versioned IDs exist (`jev-1.13.0`, `jev-1.14.0` released 2026-10-14) plus two moving aliases (`jev-latest` → 1.13.0 at capture, `jev-preview` → 1.14.0); both cost $0.042 per million input tokens with output free; the default context is 64k per request / 32k per question, raisable to 262k with a "danger zone" header; TypeSafe's latency claim is 70–500 ms (about 100 ms typical); batching many questions per state is the core cost/latency lever (official cookbook: 12.2x cheaper, 10.0x faster for 13 questions).

### Cited Findings

**Identifiers and aliases (official, Models page, captured 2026-10-15)**
- Table "Current models": Jev 1.14 Model ID `jev-1.14.0`; Jev 1.13 Model ID `jev-1.13.0`; both "Price (per Btok / per Mtok) $42 / $0.042", "Context length 64k per-request / 32k per-question", "Input Text". "Jev 1.14 is the newest Jev release, available from October 14, 2026." — [Models](https://docs.typesafe.ai/models)
- Aliases: `jev-latest` → `jev-1.13.0` "The most recent stable, official release. The default in our client SDKs, and the name the examples in these docs use." `jev-preview` → `jev-1.14.0` "The most recent release, official or not. Moves ahead of `jev-latest` when a preview build is available." — [Models](https://docs.typesafe.ai/models)
- "An alias moves when a new release ships, so its answers can change without any change to your code. Each response's `model` field gives the versioned ID that answered, so you can log which model produced each result. If you have tuned confidence thresholds against one version, send that version's ID instead of the alias, and switch to the new version when you are ready." — [Models](https://docs.typesafe.ai/models)
- jev-1.14 blog (dated Oct 14, 2026): 1.14.0 is "small, subtle improvements across the board, with the largest gain expected in multilingual support"; "`jev-latest` will move to `jev-1.14.0` in about a week"; "`jev-1.13.0` will remain available 'for a while'"; TypeSafe "plans to give 60 days' warning before deprecating `jev-1.13.0` and 30 days for `jev-1.14.0`"; "A formal deprecation policy is promised but not yet published"; new `box` type "enabled only for `jev-1.14.0`"; experimental headers `TypeSafe-Danger-Zone-Images: true` and `TypeSafe-Danger-Zone-Long-Context: true`; "Opt-in data sharing ... TypeSafe will still not train on queries"; "danger-zone features are not yet vouched for in production use". — [Jev 1.14 blog](https://typesafe.ai/blog/jev-1-14)
- HN thread for the 1.14 post: 329 points, 116 comments (2026-10-14). — [HN item 50095353](https://news.ycombinator.com/item?id=50095353)
- OpenRouter (third-party, model strings differ): `typesafe/jev-1.13`, `typesafe/jev-1.14`, `typesafe/jev-router`, `~typesafe/jev-latest` listed on the author page; OpenRouter's SDK guide says `jev-1.13` routes as `typesafe/jev-1.13` and `jev-latest` as `~typesafe/jev-latest`. — [OpenRouter TypeSafe page](https://openrouter.ai/typesafe); [OpenRouter TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)
- OpenRouter `typesafe/jev-router` page lists a 1,000,000-token context and a Sept 25, 2026 release date; it "picks the best model and reasoning effort for each request and runs on Jev" (this is a router product, not the base model). — [OpenRouter jev-router](https://openrouter.ai/typesafe/jev-router) (search snippet, 2026-10-15)
- Vercel AI Gateway model string: `typesafe-ai/jev` (no version suffix). — [Vercel Decision docs](https://vercel.com/docs/ai-gateway/modalities/decision)
- `@ai-sdk/typesafe-ai` provider accepts `jev-1.13.0`, `jev-1.14.0`, `jev-latest`, `jev-preview`. — [AI SDK TypeSafe provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai)

**Pricing (official)**
- "$42 per Btok, or $0.042 per Mtok, charged per input token. Output tokens are free." "Long context costs the same per token as any other request." — [Models](https://docs.typesafe.ai/models)
- Launch blog: input "$0.042 per million tokens ($42 per billion)"; output "free ('too cheap to meter')"; LLM comparison "$0.20 to $10 per million, with output about 5x more expensive". — [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Homepage: "$42 per billion input tokens"; "238x lower" input price than Claude Fable 5.1; comparison "TypeSafe AI run at $0.000081 and 0.114s, versus $0.013880 and 8.566s for LLMs"; headline "193.6x faster and 444.6x cheaper, 'based on workflows for System One tasks'". — [typesafe.ai](https://typesafe.ai/)
- Subsidy statement (official, verbatim from launch blog): "Cost per call: We make our pricing transparent. We can't prove it isn't subsidized; we'll need the long-term to prove the sustainability of our pricing (which we expect to go down, not up)." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Vercel gateway charges the same $0.042/M input, output free, "no markup and no platform fee on tokens" (third-party, flaviocopes, checked Sept 2026). — [flaviocopes jev-pricing](https://flaviocopes.com/jev-pricing.md)
- Vercel gateway example cost for a ~275-token request: `"cost": "0.00001155"`. — [Vercel Decision docs](https://vercel.com/docs/ai-gateway/modalities/decision)
- Credits in the MCA are "not redeemable, refundable, transferable"; TypeSafe "may decline to generate Output" if credits run out without auto-refill; fees "due within 30 days after the invoice date". — [MCA](https://typesafe.ai/legal/mca) (WebFetch summary 2026-10-15)

**Latency (official claims vs measurements)**
- Official: "End-to-end response time is 70ms-500ms for TypeSafe. This can range from 40x-200x faster for the same levels of frontier intelligence for System One shaped queries." "Speed per call: We truly are that fast, though our published evals are generally run from our laptops on the West Coast (this is where our service is currently based)." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Official: "Most queries complete in about 100 ms." — [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- Official cookbook measurement: "In this run TypeSafe has a mean round-trip latency of 111ms" (`jev-latest`, sampled 2026-09-11). — [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook)
- Official: Doom demo "about 10 queries per second ... roughly $7 per hour"; Wikiracing demo "supports cardinality up to 255, with a two-stage process for higher counts"; "high-cardinality choices can slow down". — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Third-party measurements: Cloudflare lab → Jev median 524.1 ms, p95 536.0 ms ([Cloudflare blog](https://blog.cloudflare.com/clef-decision-models)); OpenRouter Banking77 test median 175 ms ([The New Stack Workday article](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)); AY Automate via OpenRouter p50 0.33 s / p95 0.44 s; Open-Jev diagnostic p50 291.3 ms / p95 353.7 ms; WotAI p50 455 ms; LargitData p50 749 ms / p95 818 ms; founder test mean 1.0 s ([infinisynapse evidence review](https://infinisynapse.com/en/blog/jev-benchmark)); flaviocopes from Italy: not measured for Jev but "TypeSafe quotes about 100 ms" ([flaviocopes Clef deep dive](https://flaviocopes.com/clef/)).
- Jack & Jill production: median time to screen a role's candidates 20.3 s → 10.3 s; post-onboarding profile check ~3.6 s → ~0.2 s. — [Jack & Jill case study](https://typesafe.ai/blog/jack-jill-jev-case-study)
- Andrew King (Very Good Ventures, third-party): median dashboard render 29 s → 3.8 s on synthetic data. — [The New Stack](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)

**Batching semantics (official)**
- "Send every question that uses the same state in one request. You can mix question types freely. System One models evaluate every question in a request in parallel. Adding questions barely changes the response time and costs only the tokens for the extra questions." — [Primitives](https://docs.typesafe.ai/primitives)
- Parallel questions cookbook: "Runs a 13-question regulatory briefing over the GDPR Wikipedia article, showing that batching every question into one TypeSafe call is 12.2x cheaper and 10.0x faster with no change in answers." Document ~54,000 characters; 8 Noul, 2 Choice, 3 Score; "Most answers came back identical across all 5 repeats either way ... std dev exactly 0.0." "The bigger the document, the nearer that saving comes to a full Nx." — [Parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions)
- Conflicting official figure: the Primitives page says the same cookbook shows batching "is 11.5x cheaper and 9.6x faster than 13 separate calls". — [Primitives](https://docs.typesafe.ai/primitives) (contradicted by the cookbook's own 12.2x / 10.0x)
- Speculative fan-out pattern: ask all questions including ones only relevant on some branches and ignore the rest in code. — [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
- TrueStandard (third-party): six sequential judgments 74.42 s vs 0.739 s batched (100.7x); single decision 477 ms vs 790 ms for Gemini 3.1 Flash Lite. — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)

**Context limits (official)**
- "Per-request context (`per_request_context`): the `state` plus all questions combined. Per-question context (`per_question_context`): the `state` plus any one question." Default 64k / 32k. "To turn it on, send the `TypeSafe-Danger-Zone-Long-Context: true` header with each request that needs it. With the header, the per-request context and the per-question context are both 262k tokens." "It is slower and less accurate than staying within the default limits." — [Models](https://docs.typesafe.ai/models)
- Verbatim long-context curl (official):
  ```bash
  curl https://api.typesafe.ai/v1/systemone \
    -H "Authorization: Bearer $TYPESAFE_API_KEY" \
    -H "Content-Type: application/json" \
    -H "TypeSafe-Danger-Zone-Long-Context: true" \
    -d '{ "model": "jev-latest", "state": "<a long contract, transcript, or record>", "questions": { "has_termination_clause": { "type": "noul", "instructions": "Does the `state` include a clause that lets either party end the agreement early?" } } }'
  ``` — [Models](https://docs.typesafe.ai/models)
- "The `state` counts once against each of `jev-1.13`'s context limits." — [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- Over-limit requests return `400` with `max_tokens_exceeded`. — [API reference](https://docs.typesafe.ai/api)
- Rate limits: "set per organization", "measured in tokens per second and requests per second", shown at https://console.typesafe.ai/rate-limits; SDKs honor `retry-after`; "Higher limits are available on custom and enterprise plans." No numbers published. — [Models](https://docs.typesafe.ai/models)
- Third-party: early-access limits reported as "80 requests per second and 100,000 tokens per second". — [flaviocopes jev-pricing](https://flaviocopes.com/jev-pricing.md)
- Language: "English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well". — [Models](https://docs.typesafe.ai/models)
- Customization: "Jev is not fine-tuned or LoRA-adapted with customer data ... the same weights serve every account." — [Models](https://docs.typesafe.ai/models)

### Inferences
- Pin versioned IDs in production and log the response `model` field; alias moves (announced ~Oct 21 for `jev-latest` → 1.14.0) can silently shift calibrated thresholds.
- Cost per decision scales with state size, so per-decision cost in a decision engine is dominated by how much state is sent, not by question count; design the engine to pack questions and trim state.
- The "~12x cheaper, ~10x faster" numbers in the brief match the cookbook's 12.2x / 10.0x; the Primitives page's 11.5x / 9.6x looks like an earlier run.

### Gaps
- No official numeric rate limits; no official p50/p95 latency distribution; no regional endpoints (TNS reports "processes data in the U.S.").
- No published deprecation policy document yet (promised in the 1.14 post).

---

## Key Question 3: How confidence and probabilities are represented and how TypeSafe says to turn them into act / review / refuse thresholds

### Takeaway
`confidence` is a deterministic statistic computed server-side from `probabilities` (exact formulas published: Choice `(p_max − 1/n)/(1 − 1/n)`, Score an ordinal mean-absolute-deviation ratio, Noul none, with `|2p − 1|` suggested); TypeSafe explicitly says it is a shape statistic, not a correctness guarantee, and recommends a three-band policy (act / proceed with caution / do not act) with thresholds that "scale with risk" and are tuned on your own labeled data; illustrative numbers in official docs are 0.3, 0.5, 0.6, 0.75, 0.8, 0.85, 0.9.

### Cited Findings

**Definition (official, verbatim)**
- "The answer's `confidence` property collapses that shape into a single number from 0 to 1 ... It is 1 when all the probability is on one outcome and 0 when the probability is spread evenly. (Noul answers don't carry one)". "`confidence` is a statistic computed from the probability distribution the answer already gives you." — [Confidence](https://docs.typesafe.ai/confidence)
- Noul: "If you want a confidence-style number anyway ... use the distance from 0.5: confidence = |2p − 1|". — [Confidence](https://docs.typesafe.ai/confidence)
- Choice: "confidence = (p_max − 1/n) / (1 − 1/n)" ... "Only the top probability counts, so (0.6, 0.3, 0.1) and (0.6, 0.2, 0.2) both have confidence 0.4." Verbatim reference code:
  ```python
  def choice_confidence(probabilities: list[float]) -> float:
      n = len(probabilities)
      return (max(probabilities) - 1 / n) / (1 - 1 / n)
  ``` — [Confidence](https://docs.typesafe.ai/confidence)
- Score: "confidence = max(0, 1 − Σ_i p_i |i − m| / MAD_unif), MAD_unif = (1/n) Σ_i |i − (n−1)/2|" where m is the most likely level. "With three levels, (0, 0.5, 0.5) has confidence 0.25 ... (0.5, 0, 0.5) has confidence 0". Verbatim reference code:
  ```python
  def score_confidence(probabilities: list[float]) -> float:
      n = len(probabilities)
      m = probabilities.index(max(probabilities))
      spread = sum(p * abs(i - m) for i, p in enumerate(probabilities))
      even_spread = sum(abs(i - (n - 1) / 2) for i in range(n)) / n
      return max(0.0, 1 - spread / even_spread)
  ``` — [Confidence](https://docs.typesafe.ai/confidence)
- Alternatives TypeSafe suggests computing yourself: "Top probability, p_max" and "Top-to-second ratio, p_max / p_second". "TypeSafe's `confidence` is one reasonable way to summarize a distribution, not the only one." — [Confidence](https://docs.typesafe.ai/confidence)
- Wikipedia (third-party, citing docs): "The API adds derived values (choice, score, confidence) computed by fixed formulas, not by the model." — [Wikipedia: Jev (AI model)](https://en.wikipedia.org/wiki/Jev_(AI_model))

**What confidence is NOT (official)**
- "Calibration is measured across groups of predictions; it does not guarantee that an individual answer is correct." — [System One](https://docs.typesafe.ai/concepts/system-one)
- "confidence 1.0 means the returned distribution puts all its probability on one level. This describes the model's answer, not a guarantee that the answer is correct." "Different distributions can produce the same score. A score of 1.0 can mean all probability is on level 1, or half is on each of levels 0 and 2. Read `probabilities` and `confidence` alongside the score." — [Score](https://docs.typesafe.ai/primitives/score)
- "Higher confidence does not establish which answer is correct." (examples can raise confidence without changing correctness). — [Score](https://docs.typesafe.ai/primitives/score)
- "A Noul value runs from 0 to 1, but it's not a scale of the thing you asked about. It is the probability that the answer is yes." — [Noul](https://docs.typesafe.ai/primitives/noul)
- Agent-skill page: "If all you care about is choosing the best option, you just need to choose the option with the highest confidence (rather than setting a confidence threshold). If you have a specific statistical algorithm in mind, you should probably be using probabilities instead of confidence." — [Agent skill](https://docs.typesafe.ai/agent-skill)

**Official three-band policy (verbatim)**
- "High confidence: Act automatically ... Medium confidence: Proceed with caution ... you might ask the user to confirm, flag for review, or gather more information before acting. Low confidence: Do not act. Route to a human, request clarification, or fall back to a different system." "Where you draw those boundaries depends on the stakes." — [Confidence](https://docs.typesafe.ai/confidence)
- "A confidence threshold is not one number. Different actions within the same system should be gated at different levels depending on the consequences of getting it wrong." Example: `if confidence < 0.5: route_to_human` ... `check_balance` acts at any confidence ≥ 0.5 ... `approve_transfer` needs `confidence > 0.9` else `ask_user_to_confirm`. "The correct threshold values depend on your domain and the performance of the model for your use case. Start with conservative thresholds, test with your own data, and adjust as you observe results." — [Confidence](https://docs.typesafe.ai/confidence)
- Confidence-gated routing pattern (verbatim code): floor `action.confidence < 0.6` → support agent; `check_balance` at ≥ 0.6; `approve_transfer` > 0.85 auto-approve else confirm; unknown choice → support agent. "The 0.6 floor catches anything the model is genuinely uncertain about." — [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)
- Noul thresholds: "Use 0.5 when yes and no are equally easy to act on. Raise it when acting on a false yes is expensive ... Lower it when missing a true yes is expensive ... Values in the middle can go to a person rather than either code path." Example constants `YES = 0.8`, `NO = 0.2`, with `NO < value < YES` → `send_to_review`. "If reviewers see too many messages, narrow the gap between `NO` and `YES`. If too many wrong routes get through, widen it." — [Noul](https://docs.typesafe.ai/primitives/noul)
- "Route on uncertainty ... Escalate uncertain cases to a person or a more expensive reasoning model. Test thresholds by plotting confidence against accuracy on your data." Example `if answer.confidence < 0.8: route_to_human_review`. Full triage example: `spam_is_uncertain = 0.4 < spam_risk < 0.6`; escalate if uncertain `or answers["topic"].confidence < 0.75`; `spam_risk >= 0.6` → quarantine; Noul gates at `>= 0.7`; priority high if `frustration.confidence >= 0.7 and frustration.score >= 1.5`. — [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- Choice page example thresholds: `department.confidence < 0.3` → manual triage; secondary team notified if its probability `> 0.25`; `resolution.confidence < 0.5` → ask customer. "These are illustrative choices in the sample". — [Choice](https://docs.typesafe.ai/primitives/choice)
- Fan-out example thresholds: `bug_severity.score > 1.5 and bug_repro.noul > 0.6`; `refund.noul > 0.7`; `frustration.score > 1.5`. — [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
- Composite scoring: normalize each Score by `len(criteria) - 1`, then weight in code (`0.6 * severity + 0.3 * frustration + 0.1 * report_quality`). — [Score](https://docs.typesafe.ai/primitives/score)
- "Low confidence on a Score usually means one of three things. The levels overlap for this state, the question is measuring more than one thing, or the state doesn't say enough to place it." — [Score](https://docs.typesafe.ai/primitives/score)
- Box: "There is no recommended threshold yet, so tune it on your own images" (example `MIN_CONFIDENCE = 0.6`). — [Box](https://docs.typesafe.ai/primitives/box)

**Gateway-level thresholding (third-party, Vercel)**
- Vercel AI Gateway "decision fallbacks" rerun the whole request on another model when `{ question, confidenceBelow }` (Choice/Score), `{ question, probabilityBetween: [lo, hi] }` (Boolean/Noul, inclusive), or compound `any` / `all` / `atLeast {count, conditions}` matches; "`confidenceBelow` also matches conservatively when the primary Choice or Score answer has no finite confidence" (reason `confidence_unavailable`); refusals match any condition; both stages billed and run sequentially; LLM fallback returns `confidence: 0` and `probabilities: {}` sentinels on the TypeSafe-compatible surface. Guidance: "Start by recording the confidence or Boolean probability ranges associated with incorrect primary answers, then set the narrowest threshold that catches the errors worth paying the second-stage cost and latency to reassess." — [Vercel Decision Fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/decision-fallbacks)

### Inferences
- A generic engine can compute the same `confidence` client-side from `probabilities` (formulas are exact), which makes it possible to normalize confidence across providers that return probabilities but not confidence (Clef and Strands return it; OpenAI returns `confidence` for choice/score but its formula is undocumented).
- For Noul-style predicates, use `|2p − 1|` to put yes/no on the same 0–1 scale as Choice confidence, as TypeSafe itself suggests.
- TypeSafe's own examples never use a single global threshold; an engine should expose per-action thresholds plus a global floor.

### Gaps
- No official recommended default thresholds; every number in the docs is labeled illustrative.
- No official reliability diagrams or ECE numbers for any Jev version (see Q5).

---

## Key Question 4: Official rollout and failure-handling guidance (shadow, label, thresholds, fallback, enforce, monitor; fail-open vs fail-closed; max(floor, jev))

### Takeaway
The six-step rollout order and the fail-open/fail-closed + `max(floor, jev)` construction are NOT in TypeSafe's official documentation; the only source found that states them is Steve Kinney's independent course page "Jev in practice". TypeSafe's own guidance is the eight-step "How to build with TypeSafe" workflow (code in control, decompose state and questions, fan out, combine in code, route on uncertainty), its confidence three-band policy, "start conservative and adjust", and the MCA's statement that output may be inaccurate and the customer must independently evaluate it.

### Cited Findings

**Official guidance (verbatim where possible)**
- Summary box: "build a normal software workflow and insert System One only where AI is needed. Keep control flow, deterministic rules, and side effects in code. Break broad judgments into narrow, typed questions with explicit instructions and criteria. Give each question only the context it needs. Use probabilities and confidence to act, ask for review, or escalate. Ask independent questions together, then compose their answers in code." — [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- Eight design steps: "Use code when you can"; "Decompose the input state"; "Use structure in the input state"; "Decompose the questions" ("This is probably the most important concept in this guide"); "Use structure in the questions"; "Ask a lot of questions"; "Combine question outputs in code (or feed into a classical ML model)"; "Route on uncertainty" ("Test thresholds by plotting confidence against accuracy on your data"). — [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- "System One is TypeSafe's model for building AI-powered software, not agents. It does not generate code or choose its own next action." — [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- "Start with conservative thresholds, test with your own data, and adjust as you observe results." — [Confidence](https://docs.typesafe.ai/confidence)
- Jaggedness page: "Adversarial content ... Instead: be explicit in the criteria. Test your integration thoroughly before deploying it to many users." "Choice option order ... Instead: reorder the options to double check that the answer stays consistent." — [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- Agent-skill page: "Put the constants (questions and thresholds) in a single place so they're easy to review." "Routing isn't working like you expect: Check the questions and thresholds. It's possible that your thresholds are either set too high (causing false negatives) or too low (causing false positives)." — [Agent skill](https://docs.typesafe.ai/agent-skill)
- Self-consistency cookbooks measure run-to-run stability (14 Nouls x 15 runs; Jev probability std dev 0.0102, "below all LLM probability conditions here"), and the Score page advises "Choose examples with known expected levels, then test the revised descriptions on separate inputs before keeping them." — [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook); [Score](https://docs.typesafe.ai/primitives/score)
- Retry/failure handling (official): SDK default `RetryPolicy(max_retries=2, backoff_initial=0.5, backoff_max=5.0, backoff_jitter=0.25, http_statuses={408, 429, 500..599}, respect_retry_after=True, api_connection_error=True, api_timeout_error=True, timeout=30.0)` where `timeout` is "Total retry budget in seconds per SDK call"; default per-operation HTTP timeout 10.0 s (`DEFAULT_TIMEOUT`). — [Python SDK retries](https://docs.typesafe.ai/sdk/python/api/retries); [Python SDK constants](https://docs.typesafe.ai/sdk/python/api/constants)
- MCA: "THE SERVICES MAY PRODUCE INACCURATE OR ERRONEOUS OUTPUT; (II) CUSTOMER IS RESPONSIBLE FOR INDEPENDENTLY EVALUATING THE OUTPUT". — [MCA](https://typesafe.ai/legal/mca)
- Official models page on alias drift: pin the versioned ID "If you have tuned confidence thresholds against one version". — [Models](https://docs.typesafe.ai/models)

**Third-party source of the rollout order and fail-open/closed rule (Steve Kinney, independent course; page is client-rendered and could not be fetched directly, so wording is from the search summary)**
- "The guide lays out a sequence of shadow runs, labeling, threshold setting, a fallback, enforcement, and monitoring. It recommends running a Bash command gate in shadow mode behind a hook that fails open, calibrating on labeled cases, and then enforcing." — [Steve Kinney, "Jev in practice"](https://stevekinney.com/courses/ai-development-setup/jev-in-practice) (via WebSearch summary 2026-10-15)
- Quoted in the search summary: "Jev's judgments should fail _open_, so a timeout or low confidence changes nothing. Hard safety checks, like regular expressions and allowlists, should fail _closed_." and "the hard check sets a floor on the risk level, and Jev can raise risk above it but never lower it." The guide also says "choosing an action is not authorization" and that "in independent tests, Jev trailed frontier models on harder tasks." — [Steve Kinney, "Jev in practice"](https://stevekinney.com/courses/ai-development-setup/jev-in-practice) (via WebSearch summary)
- Related third-party pattern: Andrew King's generative-UI setup sends anything Jev answers "with less than 50 percent confidence" to a language model, "a cage with a door"; "A shape nobody anticipated cannot appear on screen". — [The New Stack, Workday article](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)
- LangChain's experimental `AutoModeMiddleware` blocks risky tool calls ("Risky calls return an error `ToolMessage` instead of running") — a fail-closed use of a Noul; a Towards AI write-up reports calls blocked at a score of 0.5 or above. — [LangChain TypeSafe integration](https://docs.langchain.com/oss/python/integrations/providers/typesafe.md); [Towards AI (member-only preview)](https://pub.towardsai.net/why-does-langchains-new-jev-auto-mode-forget-your-request-at-tool-call-16-493b5018a259)
- Vercel's decision fallbacks are the gateway-native "fallback" step (see Q3). — [Vercel Decision Fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/decision-fallbacks)

### Inferences
- A faithful summary for the report: TypeSafe officially says (a) keep code in control, (b) decompose, (c) batch, (d) three-band confidence routing with per-action thresholds, (e) start conservative, plot confidence vs accuracy on your own labeled data, (f) pin model versions, (g) test adversarial and option-order cases before wide deployment. The explicit "shadow → label → thresholds → fallback → enforce → monitor" ordering and `max(floor, jev)` are Kinney's synthesis and should be attributed to him, not TypeSafe.
- `max(floor, jev)` is consistent with TypeSafe's own "Combine answers in code" step (weighted sums / deterministic rules) and with its advice to keep deterministic checks in code.

### Gaps
- Could not retrieve the Kinney page text directly (JS-rendered; curl returned 148 bytes of text), so exact wording beyond the search summary is unverified.
- No official TypeSafe page uses the words "shadow", "fail-open", or "fail-closed" (grep of all downloaded docs pages found none).

---

## Key Question 5: Every documented weakness and every published accuracy/calibration number (official and independent), and the RLCD training claim

### Takeaway
TypeSafe publishes a nine-item "jaggedness" list for jev-1.13 (literal reading; counting/arithmetic/numeric representations/score math; dates; indirection and double negatives; irrelevant state; adversarial content; contradictory instructions; first-option order bias; no generation) but no calibration metrics and no technical description of RLCD; the only official accuracy figure is a self-run four-workflow eval (reported by third parties as 67.8% aggregate, "level with GPT-5"). Independent numbers cluster around 78–87% on intent/routing sets, ECE 0.12–0.14 where measured, and consistent reports of first-option bias.

### Cited Findings

**Official weaknesses (Jev 1.13 jaggedness page, "Last reviewed 2026-10-02", verbatim)**
- Preamble: "`jev-1.13` is fast, calibrated, and good at common-sense judgment but it is not perfect ... It may struggle with tasks that require additional levels of indirection. It can be quite literal in its understanding. It struggles with tasks that require numeric precision." — [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- Table: 1 Literal reading → "Write the exact condition, criteria for each available options"; 2 Math and Numbers → "Keep the arithmetic in code"; 3 Date and time comparison → "Extract components; compare in code"; 4 Indirection → "Reduce hops; point to the relevant state"; 5 Large state full of irrelevant detail → "Filter first; send only what the question needs"; 6 Adversarial content → "Write precise prompts, and test edge cases before deploying"; 7 Contradictory instructions and criteria → "Align the criteria and instruction"; 8 Choice option order → "Reorder the options and check the answer is consistent"; 9 Generation → "Use a generative model". — [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- Literal reading: "`jev-1.13` answers the question you wrote, not the one you meant. Scoping words, negations, and implied conditions are read at face value." — same page
- Counting: "`jev-1.13` does not count reliably. This covers characters in a word, occurrences of a term in a passage, and items in a long list. The model recognizes the shape of an answer rather than tallying, and the error grows with the size of the thing being counted." Workaround code asks one Noul per item (`Is \`items[{i}]\` the name of a fruit?`) and sums `noul > YES` (YES = 0.5). — same page
- Numeric representations: "questions about colors using hex values will underperform compared to those using the English names. Given RGB triples or hex values it cannot reliably judge whether two values are near each other. Similarly ... low level assembly, or binary encoded instructions." — same page
- Score math: "Please do not use score outputs (e.g., expectations and probability) to compute the exact magnitude of a number between two levels ... `jev-1.13`'s score levels are weak in numerical calibration." — same page
- Dates: "`jev-1.13` reads dates as text, not as ordered quantities. Asking which of two dates comes first, how far apart they are, or whether one falls inside a window is unreliable. It gets worse with mixed formats, relative references and domain boundaries such as quarters, settlement windows, and accrual periods." Workaround: Choice over enumerated year/month/day with a "not stated" option; see [date extraction cookbook](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook). — same page
- Indirection: "Instructions carrying double negatives or complex indirection are answered less reliably. A question about a property of a property or something that requires multiple hops of reasoning costs accuracy." — same page
- Irrelevant state: "Accuracy falls as the state grows with content unrelated to the decision." "Jev suffers from context rot, so unrelated material in the `state` costs you accuracy." — same page
- Adversarial: "State is data, and `jev-1.13` does not treat it as hostile by default. Content written to adversarially steer the model, whether that is an injected instruction, a deliberately misleading framing, or text that argues for its own classification, can move the answer. We expect to improve on this in the future." — same page
- Contradictory: "a Noul where `true` maps to no and `false` maps to yes will perform worse." — same page
- Option order: "In some cases, we observed that the order of a Choice's options can affect the answer, and `jev-1.13` leans toward the option that comes first." — same page
- Generation: "`jev-1.13` is not trained to generate text. While you can force it to by chaining choices, this will not work well and will be very slow." — same page
- Reminder box: "avoid ... Asking the model something code can compute exactly. Hiding several judgments inside one question. System Two tasks: more layers of indirections. Giving it more context in `state` than the question needs." — same page
- Noul page: "Phrase the question so that a high value means yes ... 'Is the message free of personal data?' inverts the meaning". — [Noul](https://docs.typesafe.ai/primitives/noul)
- Modality: "Jev currently accepts text input only ... Images, audio, and video are not supported (yet)" (System One page) vs images now experimental behind a header on both 1.13 and 1.14 (1.14 blog says "`jev-1.13.0` was already multimodal"; "all models, Jev included, perform worse on multimodal input than on pure text"). — [System One](https://docs.typesafe.ai/concepts/system-one); [Jev 1.14 blog](https://typesafe.ai/blog/jev-1-14)
- Launch-blog self-criticism: "No string generation. Pricing may be subsidized. Evals may be biased toward OpenAI and Anthropic models and may underestimate DeepSeek. The workflows were built by the company's own team and may not reflect real-world use. Speedups in the Wikiracing demo are smaller, and high-cardinality choices can slow down." "Jev's schema-matching rate is set to 0% by construction, not measured." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Box edge test (official, small): on 36 painting crops with a known cut-off, four per-edge Nouls caught 30, a single "Is all of the mug inside" Noul caught 26, drawing the box outline caught 20. — [Box](https://docs.typesafe.ai/primitives/box)

**RLCD (official claims)**
- "Reinforcement learning for calibrated decisions trains TypeSafe to return decisions and calibrated probabilities instead of generated text." "Higher probability should correspond to a greater chance that the answer is correct." "Outcomes assigned a probability of `0.2` should occur about 20% of the time ... `0.8` ... about 80% ... `1.0` should occur 100% of the time. These rates describe groups of predictions, not a guarantee about any single answer." RLHF "was co-invented by Diogo Almeida". — [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)
- Launch blog: RLCD "Optimizes for ... Calibrated decisions: answers with epistemically honest probabilities on System One tasks"; "Always communicates confidence and uncertainty with every output. Calibrated: higher confidence means higher accuracy. More consistent: returns similar answers for similar inputs." "The post gives no technical detail beyond its goal" and "No calibration metrics are given." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Homepage FAQ answer fragment (decoded from the page's base64 Framer attribute): "RLHF optimized LLMs for human preferences. We built Jev to be natively used by machines, with new architecture, a parallel sampler, and a new training algorithm - Reinforcement Learning for Calibrated Decisions". — [typesafe.ai](https://typesafe.ai/) (homepage HTML, 2026-10-15)
- Wikipedia (third-party): "Trained exclusively on synthetic data using RLCD ... Details are unpublished. Suspected to be supervised learning with loss terms that penalize miscalibration, possibly including the Brier score." "Architecture, weights and technical paper are unpublished. TypeSafe describes it as transformer-based." — [Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model))
- Cloudflare describes its own Clef training as including "RLCD ... partial credit for adjacent ordinal choices, reward for fully precise records, and a reference penalty against distribution shift" plus Brier loss — this is Cloudflare's reimplementation, not TypeSafe's method. — [Cloudflare Clef blog](https://blog.cloudflare.com/clef-decision-models)

**Official accuracy evidence**
- Launch blog: "Side-by-side demo: Compared against GPT-5.6 Terra with default reasoning. The only disagreement was on 'Churn likelihood level'"; "Workflow evals: Four workflows, with reference answers from the average of GPT-6 Astra and Fable 5.1. Headline claims on the homepage are 193.6x faster and 444.6x cheaper." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Third-party relays of TypeSafe's dashboard: "Jev scores 67.8%, level with GPT-5" on the four-workflow benchmark ([DigitalOcean / search summary](https://www.digitalocean.com/resources/articles/what-is-jev)); "67.8% aggregate; unnamed comparator 74.1%; GPT-5.6 Terra 67.9%; per-task 61.7% to 76.0%" ([infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)).
- Jack & Jill (official case study, offline test on 150 live roles): winners kept in top-2,000 shortlist 93.9% (Gemini 3.1 Flash Lite) → 94.6% (Jev), "+0.7 point difference was not statistically significant (90% CI −0.4 to +1.8)"; AUC 0.924 → 0.933. — [Jack & Jill case study](https://typesafe.ai/blog/jack-jill-jev-case-study)
- Official self-consistency: 14 Nouls x 15 runs, Jev probability std dev 0.0102. — [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook)

**Independent / competitor-run numbers (all third-party; most self-run by a competitor or small-sample)**
- Cloudflare model card (Jev vs Clef, %): BFCL 95.8 vs 98.5; ToolRet 65.3 vs 69.2; API-Bank 88.2 vs 91.9; BANKING77 79.7 vs 94.2; GPQA Diamond 78.3 vs 48.0; MMLU-Pro 82.7 vs 65.9; BBH 92.9 vs 73.7. TypeSafe's own workflow suite: invoice exact 61.8 vs 64.7; invoice primary 83.1 vs 86.2; customer service 76.0 vs 76.3; security incidents 61.7 vs 62.9; agent trace primary 71.6 vs 68.5 (Jev higher). — [Hugging Face Cloudflare/clef](https://huggingface.co/Cloudflare/clef)
- Cloudflare Oct 9 changelog (Jev column): BFCL 95.75; BANKING77 macro-F1 79.74; CLINC150+OOS 89.27; Amazon ESCI 57.21; PhishNChips 62.55. — [Cloudflare changelog 2026-10-09](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)
- Jev Decision Index overall (Cloudflare leaderboard, self-reported): Clef 61.2, Jev 57.9, Clef-flash 57.1, Perplexity Decider 56.4, Laya 6.0. — [flaviocopes Clef deep dive](https://flaviocopes.com/clef/); [eesel decision models](https://www.eesel.ai/blog/decision-models)
- Perplexity model card (Jev vs pplx-decider-v1-27b, %): WinoGrande 90.70 vs 83.30; FinancialPhraseBank 76.98 vs 84.18; RAGTruth 77.27 vs 88.80; JudgeBench 78.57 vs 78.29; BBH 94.27 vs 82.80; JevBench public hard 73.27 vs 70.30; TabFact 89.80 vs 90.60; ContractNLI 77.45 vs 80.78; Circa 84.60 vs 89.20; Belebele 95.00 vs 94.00; TruthfulQA binary 92.00 vs 85.40; overall 84.51 vs 85.71. "Scores were measured through the Perplexity API, not independently verified." — [Hugging Face perplexity-ai/pplx-decider-v1-27b](https://huggingface.co/perplexity-ai/pplx-decider-v1-27b)
- OpenRouter blog Banking77 test (as reported by TNS): Jev median 175 ms, 81% accuracy; Claude Opus 5 84.4%, 2.3 s, ~22x cost. — [The New Stack](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)
- JevBench v1.5.4 (Florian Standhartinger; 1,624 items: 904 open, 720 sealed; composite of chance-corrected intelligence, calibration, speed, cost): Cygnet 73.70, Winnow-12B Q8 73.23, Jev 1.13.0 72.13 (3rd), JevK5 v0.3 4B 71.90, Plumb-4B 71.56; unranked classifier.dev 74.66. — [BenchLM JevBench](https://benchlm.ai/benchmarks/jevbench)
- Open-Jev public JevBench subset: Jev 1.13.0 200/231 = 86.6%, hard subset 81/111. — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark); [Featherless](https://featherless.ai/simple-jev/evaluations)
- AY Automate: 8-way routing 83.8% (n=160; GPT-5.6 Terra 89.4%); 77-way routing 78.8% (n=231; Terra 84.0%, p=0.029); prompt-injection detection 87.0% (n=400; Claude Haiku 4.5 89.0%), Brier 0.090, AUROC 0.990; "17 confident errors (≥0.90) across the two intent tasks"; cascade at 0.80 confidence gate escalated 19.4%/23.0% to Terra at 25.7%/27.9% of Terra-only cost. — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)
- WotAI (150 passages): Jev 66.0% (= Haiku); ECE 0.121 (Haiku 0.122, Sonnet 5 0.062); 34.7% of Jev outputs in the 0.35–0.65 band vs 2.7% for Haiku. — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)
- Laya card review: Jev soft accuracy 0.580, ECE 0.144 (Laya 0.471 / 0.213). — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)
- Regolo order-effect test: reversing option order shifted probabilities from 0.84–0.89 to 0.93–0.96; correct classifications fell from 16/16 (last placement) to 12/16 (first placement). — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)
- LargitData multi-turn RAG routing (all decisions correct): Jev 61.4% vs Gemma 4 31B 77.0%. — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)
- JevBench archive: phishing 62.6% (n=2,000); Banking77 zero-shot typed choice 80.3% (n=3,080). — [infinisynapse](https://infinisynapse.com/en/blog/jev-benchmark)
- Bartosz Mikulski: 400 hand-drawn sketches as SVG coordinates → "about 35% right, where just 'guessing' typically returns 10%, but it answered 'airplane' for more than half". — [The New Stack, TypeSafe profile](https://thenewstack.io/typesafe-jev-system-one/)
- HN launch thread (1,989 points, 520 comments): main pushback on "can't hallucinate" ("if it puts a high confidence value on a wrong answer, thats still hallucinating, no?") and demand for calibration evidence ("a confidence value that is in line with the actual correctness"). — [HN item 49717558](https://news.ycombinator.com/item?id=49717558); [eesel summary](https://www.eesel.ai/es/blog/typesafe-jev)
- Strands Decider README treats first-option bias as a class-wide issue ("sensitive to reordering options with a reported bias toward the first option"). — [eesel Strands Decider](https://www.eesel.ai/blog/strands-decider)

### Inferences
- The weakness list maps directly onto adapter responsibilities: do arithmetic, counting, date math, unit/color conversion in code; randomize or double-check Choice option order; strip irrelevant state; treat state as untrusted and never let it carry instructions; phrase Nouls positively.
- Independent intent-classification accuracy (~79–84%) sits below frontier LLMs by 3–6 points but at a fraction of latency/cost; knowledge-heavy sets (GPQA, MMLU-Pro, BBH) are where Jev beats the open reimplementations.
- Calibration evidence is thin and mixed (ECE ~0.12–0.14 in two small third-party tests; one shows "confident errors" at ≥0.90), so an engine must measure calibration per question on its own labeled data rather than trust the RLCD claim.

### Gaps
- No official calibration curves, ECE, Brier, model size, architecture, or training-data description exist (confirmed by launch blog, Wikipedia, and Decision Index README).
- The homepage FAQ answers to "What is Jev good at? Where does it struggle?" and "Can Jev still get things wrong?" are client-rendered and could not be captured; the jaggedness page and the System One page's "does not guarantee that an individual answer is correct" are the closest official statements.

---

## Key Question 6: SDKs, gateways and authentication (Python, JS/TS, Vercel AI SDK/Gateway, OpenRouter, LangChain)

### Takeaway
Official SDKs are `typesafe-sdk` (PyPI, `TypeSafeClient.system_one`, async variant) and `@typesafe-ai/sdk` (npm, `client.systemOne`), both reading `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL`, defaulting to `jev-latest`, zstd-compressing bodies ≥ 1 KiB and retrying 408/429/5xx; Vercel exposes Jev as `typesafe-ai/jev` through `experimental_decide` (formerly `experimental_evaluate`), a native `/v1/evaluate` HTTP API, an OpenAI-compatible `/v1/decisions`, and a TypeSafe-compatible `/typesafe/v1/systemone`; OpenRouter accepts the TypeSafe SDK by changing base URL to `https://openrouter.ai/api`.

### Cited Findings

**Python SDK (official)**
- Install `pip install typesafe-sdk` or `uv add typesafe-sdk`; "Requires Python 3.10 or later"; extras `http2`, `pil`, `zstd`; source https://github.com/typesafe-ai/typesafe-sdk-python. — [Python SDK](https://docs.typesafe.ai/sdk/python); [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- Verbatim quickstart:
  ```python
  from typesafe_sdk import Choice, Noul, Score, TypeSafeClient
  with TypeSafeClient(model="jev-latest") as client:  # Reads TYPESAFE_API_KEY.
      response = client.system_one(
          state=ticket,
          questions={
              "department": Choice(instructions="Which team should handle this", criteria={"billing": "...", "technical": "...", "sales": "..."}),
              "frustration": Score(instructions="How frustrated the customer appears", criteria=["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"]),
              "is_urgent": Noul(instructions="The message conveys urgency or time-sensitivity"),
          },
      )
  print(response.choices["department"].choice)
  print(response.scores["frustration"].score)
  print(response.nouls["is_urgent"].noul)
  ``` — [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- Response access: `response.answers["<id>"]` (typed `ChoiceAnswer`/`ScoreAnswer`/`NoulAnswer`) and grouped `response.choices` / `response.scores` / `response.nouls`; `NoulCriteria(true=..., false=...)` for Noul criteria; `AsyncTypeSafeClient` with `async with`. — [Noul](https://docs.typesafe.ai/primitives/noul); [Python SDK](https://docs.typesafe.ai/sdk/python)
- Constants: `API_KEY_ENV = TYPESAFE_API_KEY`, `BASE_URL_ENV = TYPESAFE_BASE_URL`, `DEFAULT_MODEL_ENV = TYPESAFE_DEFAULT_MODEL`, `LOG_LEVEL_ENV = TYPESAFE_LOG_LEVEL`, `DEFAULT_BASE_URL = https://api.typesafe.ai`, `DEFAULT_MODEL = jev-latest`, `DEFAULT_TIMEOUT = 10.0` seconds per HTTP operation. — [Python SDK constants](https://docs.typesafe.ai/sdk/python/api/constants)
- Exceptions: `TypeSafeError` base; `TypeSafeAPIError` (`status`, `body`, `headers`, `endpoint`, `request_id` from `x-typesafe-request-id`); `TypeSafeBadRequestError` (400), `TypeSafeAuthenticationError` (401), `TypeSafePermissionDeniedError` (403), `TypeSafeNotFoundError` (404), `TypeSafeUnprocessableEntityError` (422), `TypeSafeRateLimitError` (429, `retry_after_ms`), `TypeSafeInternalServerError` (5xx), `TypeSafeAPIConnectionError`, `TypeSafeAPITimeoutError`, `TypeSafeAPIResponseValidationError` (`field_path` e.g. `answers.tone.confidence`). — [Python SDK exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions)
- Changelog: v0.5.7 (2026-09-14) initial release; v0.6.0 (2026-09-15) `Score.criteria` became an ordered sequence; v0.7.0 (2026-09-18) msgspec → pydantic, `system_one(..., response_model=...)`; v0.7.1 (09-21) early API-key validation, "examples for usage with AI gateways"; v0.7.3 (10-09) keep-alive 30 s; v0.7.4 (10-09) "serialize non-finite numbers as strings"; v0.7.5 (2026-10-14) zstd on by default, `Image` assets, `Box`, `attach_assets`. — [Python SDK changelog](https://docs.typesafe.ai/sdk/python/changelog)

**JavaScript/TypeScript SDK (official)**
- `npm install @typesafe-ai/sdk`; "Node.js 22 or newer"; ESM, CommonJS and TS declarations; helpers `choice(instructions, criteria)`, `score(instructions, levels)`, `noul(instructions)`, `box(instructions)`, `image()`, `Image.fromBase64()`, `withAssets` tagged template; `client.systemOne({ state, questions, model?, assets? })`; "The SDK infers answer types from your questions, so `response.answers.department.choice` has the type `\"billing\" | \"technical\" | \"sales\"`". — [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript); [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- `TypeSafeClientConfig`: `apiKey` (falls back to `TYPESAFE_API_KEY`), `baseURL` (`TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`), `compression` (default `"zstd"` on Node 22.15+, bodies under 1 KiB uncompressed, `false` to disable), `dangerouslyAllowBrowser` (default false), `defaultHeaders`, `defaultModel` (`TYPESAFE_DEFAULT_MODEL`, then `jev-latest`), `fetch`, `logger`, `logLevel` (`TYPESAFE_LOG_LEVEL`, then `warn`), `retry: Partial<RetryPolicy>`, `timeout`. — [TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)
- JS `RetryPolicy` defaults: `backoffInitialMs` 500, `backoffMaxMs` 5000, `backoffJitter` 0.25, `httpStatuses` 408, 429, 500–599, `apiConnectionError` true, `apiTimeoutError` true. — [RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)
- Changelog: v0.5.7 (2026-09-11) initial; v0.6.0 (09-15) ordered Score criteria; v0.7.0 (2026-10-14) requires Node 22, images behind `TypeSafe-Danger-Zone-Images: true`, `box` questions "use them with the `jev-preview` model", zstd ≥ 1 KiB, "allow null token counts in usage", "reject the returned promise for invalid requests instead of throwing". — [JS SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog)
- Image requests are sent as `multipart/form-data`; WebP/GIF rejected with `BadRequestError`. — [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)

**Agent skill (official)**
- `claude plugin marketplace add typesafe-ai/skills` + `claude plugin install typesafe@typesafe-ai`, or `npx skills add typesafe-ai/skills --skill typesafe-ai`; SKILL.md at https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md. — [Agent skill](https://docs.typesafe.ai/agent-skill)

**Vercel AI SDK / AI Gateway (third-party, Vercel docs)**
- Function: `experimental_decide` in `ai` 7.0.128+; "Earlier AI SDK 7 releases call it `experimental_evaluate`, which still works as a deprecated alias"; `gateway.decisionModel('typesafe-ai/jev')` (alias `gateway.evaluationModel()`); env `AI_GATEWAY_API_KEY`. — [Vercel Decision quickstart](https://vercel.com/docs/ai-gateway/getting-started/decision); [Vercel Decision docs](https://vercel.com/docs/ai-gateway/modalities/decision)
- Question types on the gateway surface: `boolean` (→ `probability`), `choice` (→ `choice`, `probabilities`), `score` (`criteria` array ≥ 2, → interpolated `score`, `probabilities` keyed `'0'`,`'1'`,...). Verbatim example answers: `{ refunded: { type: 'boolean', probability: 0.99 } }`; `{ route: { type: 'choice', choice: 'billing', probabilities: { billing: 1, shipping: 0, technical: 0 } } }`; `{ quality: { type: 'score', score: 2.97, probabilities: { '0': 0, '1': 0, '2': 0.02, '3': 0.98 } } }`. Confidence is NOT in `answers`; it is in `result.providerMetadata.typesafe.confidence[questionId]`. — [Vercel Decision docs](https://vercel.com/docs/ai-gateway/modalities/decision); [AI SDK TypeSafe provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai)
- Native HTTP: `POST https://ai-gateway.vercel.sh/v1/evaluate` with `{model, state, questions}`; response `{"model": "typesafe-ai/jev", "answers": {...}, "usage": {"inputTokens": 275, "outputTokens": 20}, "providerMetadata": {"gateway": {"routing": {...}, "cost": "0.00001155", ...}}}`. `providerOptions.gateway` supports `zeroDataRetention: true`, `only: ["typesafe-ai"]`, and `models` fallbacks. — [Vercel Decision docs](https://vercel.com/docs/ai-gateway/modalities/decision)
- TypeSafe-compatible surface: base URL `https://ai-gateway.vercel.sh/typesafe`; endpoints `POST /typesafe/v1/systemone` and `GET /typesafe/v1/models`; model `typesafe-ai/jev`; response "uses TypeSafe's field names" with `usage: {input_tokens, output_tokens}` plus `provider_metadata`; migration is `new TypeSafeClient({ apiKey: process.env.AI_GATEWAY_API_KEY, baseURL: 'https://ai-gateway.vercel.sh/typesafe' })`; BYOK supported. — [Vercel TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
- Direct provider package `@ai-sdk/typesafe-ai` (`pnpm add @ai-sdk/typesafe-ai`): env `TYPESAFE_AI_API_KEY`, `TYPESAFE_AI_BASE_URL` (default `https://api.typesafe.ai/v1`); `typeSafeAi.decisionModel('jev-latest')`; `providerOptions.typesafe.longContext: true` "raises limits to 262k tokens"; `boolean` maps to `noul`; `box` requires Jev 1.14; `result.rounding` reports two-decimal rounding; Vercel's Astra comparison used `@ai-sdk/typesafe-ai@3.0.12`. — [AI SDK TypeSafe provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai); [Vercel Jev vs Astra](https://vercel.com/i/jev-vs-gpt-6-astra)
- Vercel changelog (2026-09-16): Jev on AI Gateway, AI SDK 7.0.105+; adoption claim quoted by TNS: "within 24 hours ... more than twice as many paid teams as any previous model launch ... By hour 24, nearly 13% of paid teams were using it." — [Vercel changelog](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway); [The New Stack](https://thenewstack.io/typesafe-jev-system-one/)
- Vercel free-tier credit: "Every Vercel team gets $5 of AI Gateway credit per month on the free tier" and Jev can use it (third-party). — [flaviocopes jev-pricing](https://flaviocopes.com/jev-pricing.md)
- Sentry's `vercelAIIntegration` (SDK 11.1.0+) traces `experimental_evaluate()` calls. — [Sentry docs](https://docs.sentry.io/platforms/javascript/guides/mastra/configuration/integrations/vercelai/)

**OpenRouter (third-party)**
- Use the TypeSafe SDK unchanged with `TYPESAFE_BASE_URL=https://openrouter.ai/api` and `TYPESAFE_API_KEY=<OpenRouter key>`; SDK appends `/v1/systemone` → `https://openrouter.ai/api/v1/systemone`; model `jev-1.13` → `typesafe/jev-1.13`, `jev-latest` → `~typesafe/jev-latest`; OpenRouter adds `id`, `provider`, `usage.cost` (sample `0.00003`) "which the SDKs accept without error"; `client.models.list()` fails because `GET /api/v1/models` returns OpenRouter's shape. — [OpenRouter TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)
- OpenRouter author page lists `typesafe/jev-1.13`, `typesafe/jev-1.14`, `typesafe/jev-router`, `~typesafe/jev-latest`. — [OpenRouter typesafe](https://openrouter.ai/typesafe)
- OpenCode Zen had a limited-time `jev-1.13-free` model (third-party). — [search summary 2026-10-15](https://www.promptfoo.dev/docs/providers/typesafe/)

**LangChain (third-party)**
- Package `langchain-typesafe` (`pip install langchain-typesafe`; `[experimental]` extra for middleware); env `TYPESAFE_API_KEY`, optional `TYPESAFE_BASE_URL`; `TypeSafeClassifier()` is a Runnable invoked with `{"state": ..., "questions": {...}}` (state may be LangChain messages, converted to role/content JSON); answers grouped on `nouls`, `choices`, `scores`; `ModelRouterMiddleware(choices={name: ModelChoice(model, criteria)}, instructions)`; `AutoModeMiddleware(tools)`; traced in LangSmith. — [LangChain TypeSafe](https://docs.langchain.com/oss/python/integrations/providers/typesafe.md)
- LangChain post "Building a Harness with Jev" (Sydney Runkle) exists only via aggregators; original URL unconfirmed. — [youmind mirror](https://youmind.com/landing/x-viral-articles/jev-langchain-harness)

**Other community SDKs (third-party, unverified)**
- Java `io.github.premo-cloud:typesafe-sdk`, PHP `valksor/typesafe-sdk-php`, Rust `typesafe-rs` / `jev-rs`; promptfoo has a `typesafe` provider. — [Maven Central](https://central.sonatype.com/artifact/io.github.premo-cloud/typesafe-sdk); [Packagist](https://packagist.org/packages/valksor/typesafe-sdk-php); [docs.rs](https://docs.rs/typesafe-rs); [promptfoo](https://www.promptfoo.dev/docs/providers/typesafe/)

### Inferences
- The clean abstraction seam is the raw `/v1/systemone` JSON: Vercel (`/typesafe/...`), OpenRouter (`/api/v1/systemone`), Cloudflare Clef, and Strands Decider all accept it (with model-name and envelope differences), so a generic engine can speak TypeSafe-shape JSON and swap base URLs.
- An adapter must tolerate extra top-level fields (`id`, `provider`, `provider_metadata`, `latency_ms`) and `usage.cost`, and must not rely on `GET /v1/models` on gateways.
- Vercel's `boolean`/`probability` and camelCase `inputTokens` vs TypeSafe's `noul`/`input_tokens` is the main naming mismatch for an abstraction layer.

### Gaps
- Could not load OpenRouter's per-model pricing page for Jev (404 on `typesafe/jev-1.13` and its llms.txt); pricing on OpenRouter is only third-party-reported as the same $0.042/M.
- Python `TypeSafeClient(...)` full constructor signature not captured (page is MDX; `timeout: float | httpx2.Timeout | None`, `model`, `api_key`, `base_url`, `retry` confirmed from usage).

---

## Key Question 7: Access/signup status, free credit, FAQ answers, case studies (Jack & Jill, Workday), funding

### Takeaway
Jev launched in waitlisted early access on 2026-09-15 (with a $40M DCVC seed), opened to all on Sept 20, paused new signups on Sept 22 "to ensure quality of service"; whether direct signups have reopened is disputed (one self-interested site says Sept 27; others say still paused into October) and the homepage still says "early access"; the "$5 free credit" is third-party-reported and contradicted by other third parties (and may be Vercel's $5/month gateway credit); TypeSafe raised an $870M Series A at $7.5B on Oct 9 and claims ~1/3 of the Fortune 500 use Jev.

### Cited Findings

**Launch and access timeline**
- Launch blog byline Diogo Almeida, dated Sep 15, 2026: "Today, we are opening early access and bringing developers off the waitlist as quickly as we can." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- HN launch thread "Introducing System One Models and Jev": 1,989 points, 520 comments, 2026-09-15. — [HN item 49717558](https://news.ycombinator.com/item?id=49717558)
- Third-party timeline (flaviocopes, article dated Oct 9, status confirmed as of Sept 24): Sept 15 waitlist-only with emailed invites; Sept 20 "TypeSafe announced on X that Jev was open to everyone with no waitlist"; Sept 22 "paused signups because of demand. Accounts created before the pause keep working"; Sept 24 "Signups were still paused. The homepage had no waitlist button, only 'Sign in' and 'Contact sales'"; signup flow: typesafe.ai → Sign in → console.typesafe.ai (Google or email code) → "Meet Jev" → "Enter console" → keys at console.typesafe.ai/keys; "The docs don't cover rotation, revocation, expiry, or free credits as of September 2026." — [flaviocopes jev-api-key](https://flaviocopes.com/jev-api-key/)
- TypeSafe's pause statement as quoted by third parties: "We have seen such an immense swell of demand that we have to temporarily pause signups for Jev. We need to ensure quality of service for our existing signups, which will continue to function." — [jev-ai.org](https://jev-ai.org/blog/jev-waitlist/) (self-interested; quote also in search summary)
- "~140,000 people cleared from the waitlist within 36 hours" (third-party claim, unverified). — [search summary via jev-ai.org / swytchcode](https://www.swytchcode.com/content/jev-api-access)
- Disputed reopening: jev-ai.org says signups reopened Sept 27 with no free credit for new accounts; eesel says "The waitlist closed September 27"; a Goldie page dated October says "new sign-ups were paused because of demand"; Layer3Labs (Sept 22) says "access currently requires joining an early-access waitlist". — [jev-ai.org](https://jev-ai.org/blog/jev-waitlist/); [eesel decision models](https://www.eesel.ai/blog/decision-models); [Goldie Agency](https://juliangoldie.co.uk/jev-waitlist/); [Layer3Labs](https://www.layer3labs.io/guides/is-jev-free)
- Homepage at capture: meta description "Try our first System One Model, Jev, in early access"; links to API console and docs; no signup-status text. — [typesafe.ai](https://typesafe.ai/)
- Official docs: "Get an API key from the TypeSafe console" (https://console.typesafe.ai/keys); Playground at https://console.typesafe.ai/playground; "Set `TYPESAFE_API_KEY` in your environment (create it here)". — [Quick start](https://docs.typesafe.ai/introduction/quickstart); [Python SDK](https://docs.typesafe.ai/sdk/python)
- Gateways without waitlists: Vercel AI Gateway ("never had a waitlist"), OpenRouter. — [flaviocopes jev-api-key](https://flaviocopes.com/jev-api-key/); [search summary](https://www.swytchcode.com/content/jev-api-access)

**Free credit**
- Claim: Sept 20/21 accounts "came with $5 in free credit" (Goldie sites, aiextracash, jevaiplayground). — [aiextracash](https://aiextracash.com/tools/jev/jev-free-credit/); [jevaiplayground](https://www.jevaiplayground.com/blog/jev-open-access-free-credit)
- Contradiction: "neither typesafe.ai nor the docs mention a free tier or free credits for the direct API" (flaviocopes); "TypeSafe AI publishes no free tier, no complimentary trial credits" (Layer3Labs, Sept 22); TypeSafe's own pages found in this research contain no free-credit statement. — [flaviocopes jev-pricing](https://flaviocopes.com/jev-pricing.md); [Layer3Labs](https://www.layer3labs.io/guides/is-jev-free)
- Vercel: "Every Vercel team gets $5 of AI Gateway credit per month on the free tier" usable for Jev; a Vercel free-Jev promotion ended Sept 25/26, 2026. — [flaviocopes jev-pricing](https://flaviocopes.com/jev-pricing.md); [Vercel community thread](https://community.vercel.com/t/jev-promo-ended-yesterday-but-have-email-stating-it-ends-today/49742)

**Homepage FAQ (official question list, verbatim; answers client-rendered)**
- Questions on typesafe.ai: "Is Jev just a smaller LLM?"; "How is this different from JSON mode or structured outputs?"; "How can Jev be so fast and inexpensive?"; "Can you make Jev even faster?"; "Are these prices temporary or subsidized?"; "What is Jev good at? Where does it struggle?"; "Can Jev still get things wrong?"; "Is Jev deterministic?"; "How do I get started or ask a question?". — [typesafe.ai](https://typesafe.ai/)
- Only decoded answer (to "Is Jev just a smaller LLM?"): "RLHF optimized LLMs for human preferences. We built Jev to be natively used by machines, with new architecture, a parallel sampler, and a new training algorithm - Reinforcement Learning for Calibrated Decisions". — [typesafe.ai](https://typesafe.ai/)
- Closest official answer to "temporary or subsidized": "We can't prove it isn't subsidized; we'll need the long-term to prove the sustainability of our pricing (which we expect to go down, not up)." — [Launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- Closest official answers to "Where does it struggle?" / "Can Jev still get things wrong?": the jaggedness page (Q5) and "Calibration ... does not guarantee that an individual answer is correct" ([System One](https://docs.typesafe.ai/concepts/system-one)); "THE SERVICES MAY PRODUCE INACCURATE OR ERRONEOUS OUTPUT" ([MCA](https://typesafe.ai/legal/mca)).
- Closest official statement on determinism: "System One is designed to return stable answers across repeated evaluations" and the self-consistency cookbook's std dev 0.0102 (not zero). — [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one); [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook)

**Jack & Jill case study (official, dated Oct 7, 2026)**
- Jack & Jill: AI-brokered talent marketplace; "over 5,000 companies and more than 400,000 professionals, and raised $60M total". Problem: 6,000 candidates per open role per day scored by Gemini 3.1 Flash Lite into a top-2,000 shortlist. "Within 10 days of their first test, Jack & Jill fully deployed Jev in production, replacing Gemini 3.1 Flash Lite for 100% of calls in the initial scoring stage." — [Jack & Jill case study](https://typesafe.ai/blog/jack-jill-jev-case-study)
- Results: winners kept 93.9% → 94.6% (not significant, 90% CI −0.4 to +1.8); AUC 0.924 → 0.933; median screening time 20.3 s → 10.3 s; cost per 1,000 candidates $0.755 → $0.092 (88% lower); list prices Gemini $0.25 in / $1.50 out vs Jev $0.042 in / free out; savings $265K/yr at current volume, >$500K projected over 12 months. Offline test on 150 live roles. Jev used in 15+ workflows; new-candidate matching "under $0.10 per candidate"; profile check ~3.6 s → ~0.2 s. Quote (Matthew Wilson, CEO): "We saved ~half a million dollars last week with Jev." — [Jack & Jill case study](https://typesafe.ai/blog/jack-jill-jev-case-study)

**Workday (third-party, The New Stack, Oct 13, 2026, Frederic Lardinois)**
- Workday made Sana its AI home screen; "Workday is building the user interface on the fly — and all of that is managed by Jev." Joel Hellermark (Workday chief AI officer, Sana founder): generative UI "quite slow"; "If you use a classification model instead and you just give it all of the design components to pick from, you can literally do it instantly." "Workday gave Jev every atomic component in its design system and hard-coded none of the selection logic ... the team also had to get data preloading right." — [The New Stack](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)
- "Workday recently added TypeSafe to its list of subprocessors ... for natural language processing, intent classification, and confidence scoring" covering all product lines. "According to TypeSafe, Jev runs only on its hosted API and processes data in the U.S., and the company offers zero data retention to enterprise customers." "TypeSafe now offers a SOC 2 Type II report on request." Workday "hasn't said how large its design system is or what Sana does when no combination of components fits." Sana inside Claude loses the Jev-driven interface. — [The New Stack](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)
- Same article: "TypeSafe says a third of the Fortune 500 already use Jev but hasn't named them. Andreessen Horowitz's own announcement puts the figure at 25 percent"; CopilotKit recipe (Jev picks panel, OpenAI fallback); Vercel Labs testing a Jev mode in json-render. — [The New Stack](https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)

**Funding and company**
- Seed: $40M led by DCVC, announced with the Sept 15/16 launch; company founded 2024 by Diogo Almeida, Erik Gafni and Sasha Sheng; ~2 years in stealth. — [SiliconANGLE](https://siliconangle.com/2026-09-16/typesafe-ai-exits-stealth-with-40m-to-build-ai-for-use-by-software/); [Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model))
- Series A (official post dated Oct 9, 2026): $870M at $7.5B, led by Andreessen Horowitz with Sequoia Capital and DCVC; Martin Casado joins board; "Roughly one-third of the Fortune 500 use Jev"; roadmap "Release more machine-native models ... Add enterprise features". — [TypeSafe Series A post](https://typesafe.ai/blog/series-ai); [Pulse 2.0](https://pulse2.com/typesafe-raises-870-million-series-a-at-7-5-billion-valuation/)
- HN Series A thread: 444 points, 356 comments. — [HN item 50023450](https://news.ycombinator.com/item?id=50023450)
- Dealroom relays a16z: "one trillion tokens generated within three days of launch" (unverified). — [Dealroom](https://dealroom.co/news/161206-andreessen-horowitz-leads-870m-round-for-ai-startup-typesafe-at-7-5b-val/)
- Name: after economist William Stanley Jevons (Jevons paradox). — [The New Stack](https://thenewstack.io/typesafe-jev-system-one/); [TechCrunch](https://techcrunch.com/2026/10/01/amazon-releases-its-own-jev-clone-as-decision-models-flood-the-web/)

### Inferences
- The "$5 free credit" in the brief most plausibly conflates Vercel's $5/month gateway credit with TypeSafe's console; treat a direct-API free credit as unconfirmed.
- Current direct-signup status is undetermined from public sources; the safe engineering assumption is "may be gated; use Vercel/OpenRouter as fallback routes".

### Gaps
- No official TypeSafe statement found on signup reopening after Sept 22 (not on the homepage, docs, 1.14 post or Series A post).
- Homepage FAQ answer bodies (other than one fragment) could not be captured; a headless browser would be needed.

---

## Key Question 8: Terms of service / acceptable-use clauses that matter for building a generic decision engine on Jev

### Takeaway
The Master Customer Agreement (updated Sep 23, 2026) allows embedding the API in your own applications but prohibits offering the Services "as a standalone service", using outputs to train an imitating or "similar or competing product or service", and reverse engineering; TypeSafe will not train on customer data without consent but retains "Telemetry" rights "in perpetuity"; liability is capped at the greater of 12 months' fees or $50; API changes get only "commercially reasonable efforts" at advance notice; the AUP has no high-risk-use (employment/credit/medical) restrictions.

### Cited Findings
- Legal index (official): Data Processing Agreement https://typesafe.ai/legal/data-processing; Master Customer Agreement https://typesafe.ai/legal/mca; Privacy Policy https://typesafe.ai/legal/privacy-policy; "We also offer zero data retention (ZDR) for enterprise customers. Contact sales@typesafe.ai". — [Docs Legal](https://docs.typesafe.ai/legal)
- MCA §2.2 grants "the right to include the API into one or more software applications" for End Users; §2.3 (verbatim): Customer will not "(a) sell, lease, loan, distribute, sublicense, disclose, or otherwise offer or make the Services available as a standalone service; (b) use the Services or any Output (defined below) to perform model distillation, train a model to imitate the output of the Services, or develop (or to facilitate the development of) a similar or competing product or service; (c) reverse engineer, decompile, disassemble, or attempt to access or derive the source code or underlying data with respect to the Services ...; (d) modify or create derivative works of the Services; (e) remove or obscure any proprietary notices ...; (f) interfere with the operation of the Services; (g) bypass ...; (j) exceed any Usage Limits; (k) access the Services other than as expressly permitted ...; (l) access or use the Services in a manner that violates TypeSafe's Acceptable Use Policy (available at https://typesafe.ai/legal/acceptable-use-policy); or (m) access or use the Services or Output in a manner that violates any Law or third-party rights". — [MCA](https://typesafe.ai/legal/mca) (HTML captured 2026-10-15)
- MCA §2.4: Web Interface access limited to employees/contractors; Customer responsible for Customer Users and End Users. §2.5 (verbatim): "TypeSafe may from time to time update the Services, and that such changes may result in the API's becoming incompatible with a Customer Application. TypeSafe will use commercially reasonable efforts to provide advance notice of any updates to the API that TypeSafe believes will materially and adversely impact Customer's ability to integrate the API with Customer Applications." — [MCA](https://typesafe.ai/legal/mca)
- MCA §4.1 (verbatim): TypeSafe may use Customer Data "(c) in perpetuity ... (i) to derive and generate Telemetry, (ii) to monitor for fraud and abuse of the Services, and (iii) as necessary to comply with applicable Laws. The foregoing license does not grant TypeSafe the right to, and TypeSafe will not, include Customer Data in a dataset used to train (i.e., to modify the model weights of) any artificial intelligence or machine learning models without Customer's prior consent." §4.2: "TypeSafe hereby assigns to Customer all of its right, title, and interest, if any, in the Output." §4.3: Telemetry = "technical logs, hashes, summary statistics and classifications, metrics", usable "without restriction, including to improve the Services". — [MCA](https://typesafe.ai/legal/mca)
- MCA §9.3 (verbatim): "(I) THE SERVICES MAY PRODUCE INACCURATE OR ERRONEOUS OUTPUT; (II) CUSTOMER IS RESPONSIBLE FOR INDEPENDENTLY EVALUATING THE OUTPUT; AND (III) ... OUTPUT MAY NOT BE UNIQUE AND OTHER USERS OF THE SERVICES MAY RECEIVE OUTPUT ... THAT IS SIMILAR OR IDENTICAL". — [MCA](https://typesafe.ai/legal/mca)
- MCA: liability cap "THE GREATER OF (A) THE AMOUNTS PAID OR PAYABLE" over 12 months "or $50 USD" (§12.2); consequential damages excluded; Customer indemnifies for End User claims (§13.2(d)); suspension for breaches including payments "overdue by 30 days or more" (§6); termination for uncured breach after 30 days' notice; no refund of prepaid credits on termination (§10.3); TypeSafe "will be under no obligation to store or retain Customer Data"; confidentiality covers pricing (§14.1); amendments effective "at least 60 days after" notice (§16.7); California law, SF venue, JAMS arbitration, class-action waiver (§§15–16); no SLA, no benchmarking clause, no high-risk-use clause. — [MCA](https://typesafe.ai/legal/mca) (WebFetch summary 2026-10-15)
- Acceptable Use Policy (Sep 23, 2026): prohibits IP/privacy violations; deception (phishing, spoofing); "mislead others about whether content, including Output, was generated by AI" (1.4); hate/violence/terrorism; breaching third-party systems; weapons; trafficking; child-safety categories; "override or circumvent safety filters, security controls, or access controls" (3.3); "Intentionally driving the AI model to act against TypeSafe's policies" (3.4); scraping, probing, accessing other customers' data. "The page does not include ... high-risk or consequential-decision categories (employment, credit, housing, insurance, medical, legal, law enforcement ... automated decisions with legal effects, or resale)." — [AUP](https://typesafe.ai/legal/acceptable-use-policy)
- Privacy Policy (Nov 19, 2025): "We will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input." "will not disclose any Input to a third party other than our service providers." Retention "for as long as reasonably necessary to provide you with the Services"; no API-specific retention period. — [Privacy Policy](https://typesafe.ai/legal/privacy-policy)
- DPA (Apr 24, 2026): "Customer Personal Data will be retained for as long as necessary taking into account the purpose of the Processing"; subprocessors at https://trust.typesafe.ai/subprocessors; security details at https://trust.typesafe.ai/; EU SCCs (Modules 2 and 3) and UK Addendum. — [DPA](https://typesafe.ai/legal/data-processing)
- Website Terms of Use (separate from MCA): liability capped at $100; "Do not submit any information or other materials that you consider confidential or proprietary through the Site"; "separate agreements govern TypeSafe products and services". — [Terms](https://typesafe.ai/legal/terms)
- Docs: "Jev is not trained on customer requests or responses." — [Models](https://docs.typesafe.ai/models)
- Microsoft's Decision-1 model card "reportedly advises against using it as the sole basis for consequential decisions about people" (third-party) — relevant if the engine abstracts over Decision-1. — [search summary via Towards AI](https://pub.towardsai.net/introducing-microsoft-decision-1-fast-ai-for-real-time-decisions-e6344144ad25)

### Inferences
- A generic decision engine sold to third parties is permitted only as a "Customer Application" with its own value; exposing raw Jev as a pass-through API risks the "standalone service" clause. Caching/labeling Jev outputs to train your own classifier is explicitly risky under §2.3(b) ("train a model to imitate the output"), even though TypeSafe's own AutoResearch cookbook suggests training a downstream classical model on Jev probabilities — a tension worth legal review.
- Telemetry "in perpetuity" plus 60-day amendment notice and "commercially reasonable efforts" on breaking API changes mean the engine should isolate the Jev adapter behind a versioned interface and log model IDs per decision.

### Gaps
- Enterprise ZDR terms, SOC 2 scope, and any DPA retention table (Schedule I lists a purpose-based standard only) are not public.
- Whether the AutoResearch pattern (training a regressor on Jev outputs) is carved out from §2.3(b) is not addressed anywhere.

---

## Key Question 9: Competing decision models (Cloudflare, Amazon, OpenAI, Microsoft, others) and how their APIs compare for an abstraction layer

### Takeaway
Within 16 days of Jev, OpenAI (Decisions API on GPT-6 Luna, announced Sept 29, public beta ~Oct 7, $0.10/M input), Amazon (Strands Decider 2B, Oct 1, open source, local only) and Cloudflare (Clef 27B / Clef-flash 9B, Oct 1, Apache 2.0 open weights, Workers AI, $0.24 / $0.09 → $0.038 per M input) shipped decision models, followed by Perplexity, Microsoft Decision-1 and Liquid d1 (Oct 9), Convai's Laya and a long tail of open reproductions; Clef, Strands, Perplexity and Vercel's gateway all speak TypeSafe's `{state, questions}` / `noul|choice|score` shape, while OpenAI uses a different `input`/`questions[]`/`predicate|choice|score` schema with `choices[{value,description}]` and `levels[{label,description}]`.

### Cited Findings

**Cloudflare Clef family (official Cloudflare sources)**
- Announcement (blog by Michelle Chen, published 2026-10-01, Birthday Week): "Introducing Clef: our open-source decision models, and new RL fine-tuning platform". Clef freezes "Qwen3.8-27B", Clef-flash freezes "Qwen3.5-9B"; "Prefill-only, non-autoregressive decision step"; "routing head trained jointly with rank-256 low-rank adapters"; "label-smoothed cross-entropy ... plus a Brier loss for calibration"; synthetic data; RLCD variant; vision encoder; "Fully Jev-API compatible, with strictly typed outputs"; "Context window: 64k tokens for Clef, versus 32k for Jev"; open weights Apache 2.0 at https://huggingface.co/Cloudflare/clef and https://huggingface.co/Cloudflare/clef-flash; docs https://developers.cloudflare.com/workers-ai/models/clef; "Cloudflare says it does not read, store, or train on requests or responses, unless the customer opts into the fine-tuning product"; RL fine-tuning platform phase 1 = forward-deployed engineers, phase 2 = self-serve. — [Cloudflare blog](https://blog.cloudflare.com/clef-decision-models)
- Latency table (median / p95 ms, Cloudflare-run across 43 benchmarks): Clef 209.3 / 238.6; Clef-flash 38.8 / 122.4; Jev 524.1 / 536.0; DiffusionGemma Jev 84.4 / 211.2; Kev-9B 51.4 / 187.9; Laya 5.8 / 222.5. — [Cloudflare blog](https://blog.cloudflare.com/clef-decision-models)
- Benchmark claims: "Clef-flash beats Jev on 7 of 10: BFCL, ToolRet, API-Bank, Home appliances, BANKING77, Amazon ESCI, and PhishNChips. It trails on When2Call, CLINC150+OOS, and BRIGHT. Clef beats Jev on 8 of 10 ... trails only on When2Call and BRIGHT." TypeSafe's workflow suite: Clef wins 3 of 4. — [Cloudflare blog](https://blog.cloudflare.com/clef-decision-models)
- Workers AI model page: id `@cf/cloudflare/clef`; "$0.24 per M input tokens", no output charge, media converted to input tokens; context 65,536 tokens, text `state` truncated to fit; input schema: `model` must match `^\s*(clef|clef-flash)\s*$`; `questions` object "1 to 64 entries", keys letters/digits/`_`/`.`/`-` max 100 chars; `questions.*.type` `noul|choice|score`; `criteria` object (choice) or array (score); `images` array optional, max 4, PNG/JPEG/WebP, each ≤ 4 MiB and 16 megapixels, total decoded 8 MiB, body 13 MiB, no remote URLs ("a Clef extension to the System One API"); image tokens: 32x32 px per token + 3 markers, capped 1,024 tokens per image; output `{model, answers, usage}`. — [Workers AI Clef](https://developers.cloudflare.com/workers-ai/models/clef)
- Oct 9 changelog: `@cf/cloudflare/clef-omni` (30B MoE, 3B active; text + image + audio WAV/MP3 + video MP4/WebM via base64 `images`/`audio`/`videos`; ~20 ms text, <100 ms image/audio, ~300 ms for 21 s video; $0.150/M input; 64K context); Clef-flash price "$0.038 per million input tokens," down from $0.090 ("cheaper than Jev"), hosted context cut from 64K to 24K ("0.24% of requests exceed 24K"), self-hosted weights support 256K; Clef "$0.240 per million", 64K, "up to 2x faster" via SGLang 0.5.22. Benchmarks (Clef-omni / Clef / Clef-flash / Jev): BFCL 98.2 / 98.47 / 98.76 / 95.75; BANKING77 94.8 / 94.20 / 90.93 / 79.74; CLINC150+OOS 97.7 / 97.43 / 66.77 / 89.27; Amazon ESCI 57.8 / 57.48 / 57.39 / 55.21; PhishNChips 73.2 / 79.60 / 75.05 / 62.55. — [Cloudflare changelog 2026-10-09](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)
- REST endpoint `https://api.cloudflare.com/client/v4/accounts/<account ID>/ai/run/@cf/cloudflare/<model>` returns an envelope `{success, errors, messages, result: {model, answers, usage}}`; Workers binding `env.AI.run('@cf/cloudflare/clef-flash', body)` returns answers directly; auth = Cloudflare API token with Workers AI permissions; sending `jev-latest` as model returns error 5006; `usage.output_tokens` always 0 in tests; author-measured latency from Italy: Clef-flash median 191–205 ms, Clef 524–726 ms, image requests 13–30 s on launch day; Neurons billing $0.011 per 1,000, 10,000 free/day. — [flaviocopes Clef deep dive](https://flaviocopes.com/clef/) (third-party)
- HF model card: Clef 27B BF16, "joint schema head" reading backbone final hidden states, "no free-form text generation and no output parsing", serving via SGLang/vLLM/Docker Model Runner, `encode_record` default max 16,384 tokens; Decision Index numbers vs Jev as listed in Q5. — [Hugging Face Cloudflare/clef](https://huggingface.co/Cloudflare/clef)
- The Register (via search summary) confirmed with Cloudflare's PM that training datasets aren't public (open-weight, not fully open-source). — [search summary 2026-10-15](https://www.vktr.com/ai-platforms/cloudflare-open-sources-clef-decision-models/)

**Amazon / AWS Strands Decider 2B (official README + press)**
- TechCrunch (Oct 1, 2026, Tim Fernholz): AWS Strands Labs released Strands Decider 2B, "fully open sourced, available now, and small enough to run locally," built on "the 'torso' of ... Qwen3.5-2B"; Marc Brooker: such models "make a perfect decider for a workflow step"; Almeida: competitors "might be underestimating the difficulty of making the models actually smart". — [TechCrunch](https://techcrunch.com/2026/10/01/amazon-releases-its-own-jev-clone-as-decision-models-flood-the-web/)
- README: "A small, fast decision model for agentic AI"; Qwen3.5-2B-Base torso, LM head discarded, ~1M-parameter pointer head, rank-16 LoRA, 1.9B params, Apache 2.0; `pip install strands-decider`; CLI `strands-decider ask StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --state "..." --choice "Which team should handle this?=billing,sales,retail"`; server `strands-decider serve <model> --port 8000` exposing `POST /v1/systemone`. Verbatim response:
  ```json
  {
    "model": "strands-decider-2B-qwen3.5-v1-2610",
    "answers": { "is_urgent": { "type": "noul", "noul": 0.8581 } },
    "usage": { "input_tokens": 86, "output_tokens": 1 },
    "latency_ms": 489.01
  }
  ```
  "nothing caps how many options a question may carry"; vision only with `--vision` on Qwen3.5; JevBench public 231 tasks: v1 0.779 (Brier 0.280, ECE 0.072), v21 0.762 (0.323 / 0.064), v19 0.723 (0.342 / 0.052); RTX 3090 median 115 ms, p95 299 ms; "answers at a confidence of 0.9 or more 'are right about 95% of the time'" on unseen short classification. — [GitHub strands-labs/strands-decider](https://github.com/strands-labs/strands-decider)
- Third-party test notes: default context 4,096 tokens; CUDA/MPS/MLX/CPU; "Compatibility with the Jev API itself is not verified"; no hosted endpoint on Bedrock; no auth on local server; v19 ranked 3rd of 33 in the 2B class behind FlyMy.AI decision-2b (0.753) and system-one-open (0.732); "GPT-6 Luna scored 0.996"; HN launch thread passed 270 points. — [eesel Strands Decider](https://www.eesel.ai/blog/strands-decider)

**OpenAI Decisions API (official OpenAI docs + press)**
- Announced at DevDay Sept 29, 2026 ("Limited preview ... broad release is planned for the coming days"); "OpenAI says its model returns results in 150 milliseconds, compared to GPT-6 Luna, which would take 1.6 seconds." — [The New Stack, Sept 29](https://thenewstack.io/openai-decision-api-luna/)
- Public beta (TNS, Oct 7, Meredith Shubel): "OpenAI opened its Decisions API to public beta and added image inputs"; "billing its decision model at $0.10 per 1M input tokens. There are no output-token charges, nor charges for cache reads or writes"; three outputs: predicates, choices, scores; "OpenAI's decision to keep its model behind a hosted API". — [The New Stack, Oct 7](https://thenewstack.io/openai-decision-models-deployment/)
- Official reference: `POST /v1/decisions`; "Supported model: `gpt-6-luna` (the only model currently available)"; public beta, GA "in the coming weeks"; request `model`, `input` (string or user messages with `input_text`/`input_image` parts), `questions` array each with unique `name`; `predicate` {type,name,instructions} → `probability`; `choice` {..., `choices: [{value, description}]`} → `choice`, `probabilities: [{value, probability}]`, `confidence`; `score` {..., `levels: [{label, description}]`} → `score`, `probabilities: [{value, label, probability}]`, `confidence`; `refusal` answer type; images must be inline base64 data URLs; "$0.10 per 1M tokens" input only; ZDR/HIPAA/data residency supported; SDK versions Python 3.26.0, JS 7.30.0. Verbatim curl:
  ```bash
  curl https://api.openai.com/v1/decisions \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{ "model": "gpt-6-luna", "input": "I was charged twice for my order.",
          "questions": [{ "type": "choice", "name": "department",
            "instructions": "Which department should handle this complaint?",
            "choices": [ {"value": "billing", "description": "Payments, invoices, and refunds."},
                         {"value": "other", "description": "Requests outside these categories."} ] }] }'
  ``` — [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
- Vercel's OpenAI-compatible surface documents limits OpenAI's page omits: `choice` "between 1 and 255 `choices`", `score` "between 2 and 10 `levels`", up to 128 images per request, `name` optional (returns `name: null`), refused questions return `{"type": "refusal", "name": ...}` and are still billed; model slug on Vercel `openai/gpt-6-luna-decisions`; verbatim response:
  ```json
  { "model": "openai/gpt-6-luna-decisions",
    "answers": [
      { "type": "predicate", "name": "damaged", "probability": 0.95 },
      { "type": "choice", "name": "queue", "choice": "shipping", "confidence": 0.81,
        "probabilities": [ { "value": "billing", "probability": 0.19 }, { "value": "shipping", "probability": 0.81 } ] },
      { "type": "score", "name": "urgency", "score": 1.3, "confidence": 0.62,
        "probabilities": [ { "value": 0, "label": "low", "probability": 0.08 }, { "value": 1, "label": "medium", "probability": 0.54 }, { "value": 2, "label": "high", "probability": 0.38 } ] } ],
    "usage": { "input_tokens": 96, "output_tokens": 0, "total_tokens": 96 } }
  ``` — [Vercel OpenAI-compatible Decisions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions)
- Community anecdote: a biased-coin test gave 70% as predicate but 98% as choice (calibration differs by question type). — [OpenAI community thread](https://community.openai.com/t/decisions-api-is-now-available-in-public-beta/1403877/10)
- "GPT-6 Luna scored 0.996" on JevBench, "cited as a reasoning-model result"; Luna's outputs "are not calibrated probabilities" per eesel (third-party opinion). — [eesel decision models](https://www.eesel.ai/blog/decision-models)

**Microsoft Decision-1 (third-party + Vercel)**
- Vercel changelog Oct 9, 2026: id `microsoft/microsoft-decision-1`; yes/no, choice, score; "Choice and score answers include a probability for each option"; available via AI SDK decision API, OpenAI-compatible and TypeSafe-compatible surfaces; no Azure account needed. — [Vercel changelog](https://vercel.com/changelog/microsoft-decision-1-now-available-on-ai-gateway)
- Third-party: live Oct 9 on OpenRouter and in Microsoft Foundry (GA, Version 1); "$0.042 per million tokens and output is free" (matches Jev's price); "post-trained from Alibaba's open-weight Qwen3.5-9B and is offered only as a service"; model card reportedly advises against sole-basis consequential decisions about people. — [eesel Microsoft-Decision-1](https://www.eesel.ai/blog/microsoft-decision-1); [cloudprice.net](https://cloudprice.net/models/microsoft-decision-1); [Pillitteri](https://pasqualepillitteri.it/en/news/22320/microsoft-decision-1-launch-qwen-jev)

**Liquid AI d1, Laya, Perplexity, others**
- Liquid AI d1: `liquid/d1` on Vercel (Oct 9); Choice/Score/Boolean; text and image input; no pricing/size/weights stated. — [Vercel changelog](https://vercel.com/changelog/liquid-ai-d1-is-available-on-ai-gateway)
- Laya (Convai Innovations): `convaiinnovations/laya` and `convaiinnovations/laya-free` (free through Oct 31, 2026 via Boundless); third-party: 421M encoder, Apache 2.0, 100+ languages, 5.8 ms median, Decision Index 6.0, BANKING77 0.425 vs Jev 0.870. — [Vercel changelog](https://vercel.com/changelog/laya-decision-model-now-available-on-ai-gateway-free-through-october-31); [eesel decision models](https://www.eesel.ai/blog/decision-models)
- Perplexity `pplx-decider-v1-27b` (and v1.1): 26B, from Qwen3.8-27B, Apache 2.0, `choice` and `noul` types, images via `predict(images=[...])`, Python `Decider.from_pretrained`, no hosted provider; overall 85.71 vs Jev 84.51 on 11 benchmarks (Jev wins 6). — [Hugging Face pplx-decider-v1-27b](https://huggingface.co/perplexity-ai/pplx-decider-v1-27b)
- Long tail (third-party, mostly Decision Index / HN): Fastino GLiNER2.5-Decide (released nine days after Jev) ([ibl.ai](https://ibl.ai/blog/decision-layer-models-nine-days-own-the-router.md)); InternLM Intern-Decision-4B (HF, Sept 26, unannounced) ([OrcaRouter](https://www.orcarouter.ai/blog/intern-decision-4b-quiet-release)); Stanford/NVIDIA CLM-8B ([Pillitteri](https://pasqualepillitteri.it/en/news/20652/ai-decision-models-run-locally)); Kev-9B, Bespoke-Nimble-9B-v2 (39.6), Tev1-4B (Together, 29.0), PostHog Jeeves, FlyMy.AI decision-2b, NeoHorse-Jev-4B, Cygnet, Winnow-12B, Plumb-4B, classifier.dev ([eesel](https://www.eesel.ai/blog/decision-models); [BenchLM JevBench](https://benchlm.ai/benchmarks/jevbench)); `von` "Sub-15ms, non-autoregressive, local drop-in alternative" ([GitHub wfzyx/von](https://github.com/wfzyx/von)); `mini-jev` on top of a local LLM ([GitHub r-ms/mini-jev](https://github.com/r-ms/mini-jev)); Microsoft, Databricks and Liquid AI named in a Tech Jack Solutions brief ([techjacksolutions](https://techjacksolutions.com/?p=94989)).
- Jev Decision Index (community HF Space by multimodalart, 680 likes): "70 open reproductions" at v0.2.1 (HN, Oct 2); full score = 20% public benchmarks + 50% private same-skill tests + 30% private new-domain tasks; 37 public benchmarks in five areas, chance-corrected; "unofficial, community-maintained, and not affiliated with TypeSafe AI"; entries self-reported. — [HF Space README](https://huggingface.co/spaces/multimodalart/jev-decision-index/raw/main/README.md); [HN item 49934879](https://news.ycombinator.com/item?id=49934879)
- Roundup article titles: Towards AI "An ex-OpenAI researcher built an AI that only picks from a list — and 3 giants followed within 16 days" (member-only; says OpenAI, Amazon and Cloudflare all shipped within 16 days and Cloudflare "beat Jev on 7 of 10"); Pillitteri counts "at least five models of the same type" in three weeks; no article titled "Four Decision Models Shipped in Three Weeks" was found. — [Towards AI](https://pub.towardsai.net/an-ex-openai-researcher-built-an-ai-that-only-picks-from-a-list-and-3-giants-followed-within-16-fcf3937afaa7); [Pillitteri](https://pasqualepillitteri.it/en/news/20652/ai-decision-models-run-locally)

**API-shape comparison for an abstraction layer (compiled from the sources above)**
- TypeSafe Jev: `POST /v1/systemone`; `{state: str|obj|arr, model, questions: {id: {type: noul|choice|score|box, instructions, criteria}}}`; Choice `criteria` = map (≤255, null allowed), Score `criteria` = ordered array (2–10), Noul `criteria` = optional `{true,false}`; answers map `{id: {type, noul | choice+probabilities(map)+confidence | score+legend+probabilities(map,str keys)+confidence | box+confidence}}`; `usage.input_tokens/output_tokens`; text only (images experimental via header); 64k/32k (262k header); Bearer `TYPESAFE_API_KEY`; $0.042/M in, out free. — [API reference](https://docs.typesafe.ai/api); [Models](https://docs.typesafe.ai/models)
- Cloudflare Clef: same body plus `images[]` (≤4), `model` ∈ {clef, clef-flash, clef-omni}; ≤64 questions; REST wraps in `result`; token auth; 65,536 ctx (flash hosted 24K); $0.24 / $0.038 / $0.15 per M in. — [Workers AI Clef](https://developers.cloudflare.com/workers-ai/models/clef); [changelog 10-09](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)
- Strands Decider: same body, local `POST /v1/systemone`, no auth, adds `latency_ms`, `output_tokens: 1`; 4,096 ctx default; free. — [GitHub strands-decider](https://github.com/strands-labs/strands-decider)
- OpenAI Decisions: `POST /v1/decisions`; `{model: "gpt-6-luna", input: str|messages, questions: [{type: predicate|choice|score, name, instructions, choices:[{value,description}] | levels:[{label,description}]}]}`; answers array in question order with `probabilities` as arrays of objects; `refusal` type; images base64 ≤128; $0.10/M in. — [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions); [Vercel OpenAI-compatible](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions)
- Vercel AI Gateway (covers Jev, OpenAI, Microsoft, Liquid, Laya): `POST /v1/evaluate` with `{model, state, questions: {id: {type: boolean|choice|score, instructions, criteria}}}` → `{model, answers: {id: {type, probability | choice+probabilities | score+probabilities}}, usage: {inputTokens, outputTokens}, providerMetadata}`; plus `/v1/decisions` (OpenAI shape) and `/typesafe/v1/systemone` (TypeSafe shape); confidence only in `providerMetadata.typesafe.confidence`; decision fallbacks via `providerOptions.gateway.models`. — [Vercel Decision docs](https://vercel.com/docs/ai-gateway/modalities/decision); [Vercel Decision Fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/decision-fallbacks)
- LangChain `TypeSafeClassifier` and OpenRouter both wrap the TypeSafe shape. — [LangChain](https://docs.langchain.com/oss/python/integrations/providers/typesafe.md); [OpenRouter guide](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)

### Inferences
- A provider-neutral internal schema should be: `state` (any JSON), ordered list of questions with `id`, `kind ∈ {predicate, choice, score, box}`, `instructions`, `options: [{value, description?}]` or `levels: [{label, description?}]`, and `criteria_true/false`; normalize answers to `{id, kind, probability | {choice, probabilities: {value: p}, confidence} | {score, probabilities: {level_index: p}, legend, confidence}}`, with `confidence` recomputed client-side from probabilities using TypeSafe's published formulas when a provider omits it (OpenAI's `confidence` is undocumented, LLM fallbacks give none).
- Provider deltas to encode: TypeSafe `score.probabilities` keys are strings, OpenAI's are integers inside objects, Vercel's are strings; TypeSafe/Clef/Strands key answers by id, OpenAI by position + `name`; limits differ (Clef 64 questions, OpenAI 128 images, TypeSafe no question cap but 32k/question).
- Clef-flash at $0.038/M input now undercuts Jev's $0.042 and is open-weight, which changes the cost argument for the engine; Jev's remaining differentiators per third-party numbers are knowledge-heavy benchmarks and TypeSafe's hosted calibration claims.

### Gaps
- No OpenAI-published limits on choices/levels/questions (only Vercel's relay), no OpenAI latency SLA, and no published calibration for Luna decisions.
- Microsoft Decision-1 and Liquid d1 have no primary-source technical pages found (pricing, context, limits all third-party or absent).
- Cloudflare's claimed Jev numbers were run by Cloudflare against TypeSafe's hosted API; TypeSafe has not responded publicly to the Decision Index figures in any source found.
