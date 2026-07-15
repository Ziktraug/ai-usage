# Model pricing audit — 2026-07-15

Status: research snapshot as of 2026-07-15. The “Current table” comparisons
refer to the pre-fix `packages/report-core/src/pricing.ts`; the implementation
was updated from this audit afterward.

All token prices below are USD per 1 million tokens unless stated otherwise.
“Cache read” means a cache hit. “Cache write” is shown only when the provider
publishes a distinct write price. Free API tiers, batch/flex/priority modes,
regional routing, tools, storage, subscriptions, and negotiated enterprise
prices are not silently folded into the standard token rate.

## Executive summary

The current table is not complete enough to price all recently released models:

| Provider | Current state | Highest-priority changes |
| --- | --- | --- |
| OpenAI | Partially current with severe substring collisions | Add exact GPT-5.6 Sol/Terra/Luna and GPT-5.4 Pro/mini/nano IDs; correct GPT-5.5 Pro, GPT-5.2, GPT-5.1, and GPT-5/Codex rates; represent GPT-5.6 cache writes and long-context multipliers |
| Anthropic | Partially current | Add `claude-mythos-5`; price Sonnet 5 at its temporary rate through 2026-08-31; stop generic `opus`, `sonnet`, and `haiku` keys from mispricing legacy models; represent 1-hour cache writes separately or document the loss |
| DeepSeek | Flash is current | Add `deepseek-v4-pro`; retire compatibility aliases on 2026-07-24 |
| Z.AI | Text rates are current | Add vision model IDs before generic text keys; distinguish limited-time free cache storage from a zero cache-write rate |
| Google | Entire family is unknown | Add Gemini 3.5, 3.1, 3, and still-active 2.5 model-specific rates; the current `gemini` sentinel prices every model at zero with `known: false` |
| Moonshot / Kimi | Entire family is unknown | Add Kimi K2.7 Code, K2.6, K2.5, and Moonshot V1 exact IDs; remove discontinued K2 aliases rather than pricing them indefinitely |
| MiniMax | Entire family is unknown | Add MiniMax M3 and M2.7, including context-tier and high-speed differences |

The current resolver uses `model.includes(key)`. This creates correctness bugs
that a price refresh alone cannot solve: broad keys can absorb legacy Claude
models and GLM vision models before a more accurate rule is reached. Exact IDs
or longest-key-first matching should be preferred.

## OpenAI

Official sources: [current OpenAI model catalog](https://developers.openai.com/api/docs/models),
[GPT-5.6 launch and pricing](https://openai.com/index/gpt-5-6/), and the
linked first-party model pages in the table below. GPT-5.6 reached general
availability on 2026-07-09, after the current pricing table was created. The
API exposes Sol, Terra, and Luna; the `gpt-5.6` alias routes to Sol.

| Exact API ID | Input | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| [`gpt-5.6` / `gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | 5 | 0.50 | 6.25 | 30 | Above 272k input tokens, the full request is billed at 2x input and 1.5x output | Incorrect: generic `gpt-5` returns 2.50 / 0.25 / 2.50 / 15 |
| [`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | 2.50 | 0.25 | 3.125 | 15 | Same long-context multiplier | Partial only by accident: input, cache read, and output match generic `gpt-5`, but cache write and context pricing do not |
| [`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 1 | 0.10 | 1.25 | 6 | Same long-context multiplier | Incorrect: generic `gpt-5` returns 2.50 / 0.25 / 2.50 / 15 |
| [`gpt-5.5`](https://developers.openai.com/api/docs/models/gpt-5.5) | 5 | 0.50 | Not separately published | 30 | Above 272k input tokens, 2x input and 1.5x output; regional processing adds 10% | Partial: standard input, cache read, and output are correct; modifiers are absent and `cw: 5` is not a published GPT-5.5 write category |
| [`gpt-5.5-pro`](https://developers.openai.com/api/docs/models/gpt-5.5-pro) | 30 | No discount | Not separately published | 180 | Regional processing adds 10% | Incorrect: broad `gpt-5.5` returns 5 / 0.50 / 5 / 30 |
| [`gpt-5.4`](https://developers.openai.com/api/docs/models/gpt-5.4) | 2.50 | 0.25 | Not separately published | 15 | Above 272k input tokens, 2x input and 1.5x output; regional processing adds 10% | Partial: standard input, cache read, and output are correct; modifiers are absent |
| [`gpt-5.4-pro`](https://developers.openai.com/api/docs/models/gpt-5.4-pro) | 30 | No discount | Not separately published | 180 | Same long-context and regional modifiers | Incorrect: broad `gpt-5.4` returns 2.50 / 0.25 / 2.50 / 15 |
| [`gpt-5.4-mini`](https://developers.openai.com/api/docs/models/gpt-5.4-mini) | 0.75 | 0.075 | Not separately published | 4.50 | Regional processing adds 10% | Incorrect: broad `gpt-5.4` returns 2.50 / 0.25 / 2.50 / 15 |
| [`gpt-5.4-nano`](https://developers.openai.com/api/docs/models/gpt-5.4-nano) | 0.20 | 0.02 | Not separately published | 1.25 | Regional processing adds 10% | Incorrect: broad `gpt-5.4` returns 2.50 / 0.25 / 2.50 / 15 |
| [`gpt-5.3-codex`](https://developers.openai.com/api/docs/models/gpt-5.3-codex) | 1.75 | 0.175 | Not separately published | 14 | Standard API rate | Correct for input, cache read, and output |
| [`gpt-5.2`](https://developers.openai.com/api/docs/models/gpt-5.2) | 1.75 | 0.175 | Not separately published | 14 | Previous frontier model | Incorrect: generic `gpt-5` returns 2.50 / 0.25 / 2.50 / 15 |
| [`gpt-5.1-codex`](https://developers.openai.com/api/docs/models/gpt-5.1-codex) | 1.25 | 0.125 | Not separately published | 10 | Deprecated | Incorrect: explicit table row returns 1.75 / 0.175 / 1.75 / 14 |
| [`gpt-5`](https://developers.openai.com/api/docs/models/gpt-5) | 1.25 | 0.125 | Not separately published | 10 | Previous model | Incorrect: generic table row returns 2.50 / 0.25 / 2.50 / 15 |

GPT-5.6 introduces an explicit prompt-cache write price at 1.25x uncached
input and keeps the 90% cache-read discount. That rule applies to GPT-5.6 and
later models; it must not be retroactively inferred for earlier families whose
official pages do not publish a distinct write category. Batch, Flex, Priority,
regional processing, tool-call fees, and Codex subscription credits remain
separate from the standard pay-as-you-go token rate.

## Anthropic / Claude

Official sources: [Claude model IDs](https://platform.claude.com/docs/en/about-claude/models/overview)
and [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing).

| Exact Claude API ID | Input | Cache read | Cache write, 5 min | Cache write, 1 hour | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `claude-fable-5` | 10 | 1 | 12.50 | 20 | 50 | Generally available; Batch is 5 / 25 | Partial: generic `fable` has the correct standard and 5-minute values, but cannot represent 1-hour writes |
| `claude-mythos-5` | 10 | 1 | 12.50 | 20 | 50 | Limited availability; same specifications and pricing as Fable 5 | Missing |
| `claude-mythos-preview` | Not separately published | Not separately published | Not separately published | Not separately published | Not separately published | Invitation-only; the official model page names it but does not publish a distinct row in the price table | Missing; must remain unknown unless Anthropic publishes or contractually supplies a rate |
| `claude-opus-4-8` | 5 | 0.50 | 6.25 | 10 | 25 | Fast mode: 10 / 50; Batch: 2.50 / 12.50 | Partial: standard and 5-minute cache values correct; 1-hour and fast mode unrepresented |
| `claude-opus-4-7` | 5 | 0.50 | 6.25 | 10 | 25 | Fast mode: 30 / 150 until removal on 2026-07-24; Batch: 2.50 / 12.50 | Partial for the same reason |
| `claude-opus-4-6` | 5 | 0.50 | 6.25 | 10 | 25 | Batch: 2.50 / 12.50 | Partial for the same reason |
| `claude-opus-4-5` | 5 | 0.50 | 6.25 | 10 | 25 | Batch: 2.50 / 12.50 | Partial for the same reason |
| `claude-opus-4-1` | 15 | 1.50 | 18.75 | 30 | 75 | Deprecated | Incorrect: generic `opus` returns 5 / 0.50 / 6.25 / 25 |
| `claude-sonnet-5` | 2 | 0.20 | 2.50 | 4 | 10 | Introductory price through 2026-08-31; becomes 3 / 0.30 / 3.75 / 6 / 15 on 2026-09-01 | Incorrect today: generic `sonnet` returns the future standard rate |
| `claude-sonnet-4-6` | 3 | 0.30 | 3.75 | 6 | 15 | Batch: 1.50 / 7.50 | Partial: standard and 5-minute values correct; 1-hour writes unrepresented |
| `claude-sonnet-4-5` | 3 | 0.30 | 3.75 | 6 | 15 | Batch: 1.50 / 7.50 | Partial for the same reason |
| `claude-haiku-4-5-20251001` / alias `claude-haiku-4-5` | 1 | 0.10 | 1.25 | 2 | 5 | Batch: 0.50 / 2.50 | Partial: standard and 5-minute values correct; 1-hour writes unrepresented |
| `claude-haiku-3-5-*` | 0.80 | 0.08 | 1 | 1.60 | 4 | Retired first-party; still available on some cloud platforms | Incorrect: generic `haiku` returns 1 / 0.10 / 1.25 / 5 |

Additional modifiers that the four-field `Rates` type cannot express:

- `inference_geo: "us"` multiplies every token category by 1.1 for Opus 4.6,
  Sonnet 4.6, and later models; global routing is the default.
- Regional or multi-region partner-cloud endpoints add 10% for Claude 4.5 and
  later, but those are partner prices rather than the first-party Claude API.
- Batch discounts input and output by 50%; it can combine with prompt caching.
- Fable 5, Mythos 5, Opus 4.8/4.7/4.6, Sonnet 5, and Sonnet 4.6 retain standard
  token rates across their full 1M-token context windows.

## DeepSeek

Official source: [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/).

| Exact API ID | Input, cache miss | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | --- | ---: | --- | --- |
| `deepseek-v4-flash` | 0.14 | 0.0028 | Not separately billed | 0.28 | 1M context; thinking and non-thinking modes | Correct for normal input, cache hit, and output; current `cw: 0.14` is an approximation, not a published write category |
| `deepseek-v4-pro` | 0.435 | 0.003625 | Not separately billed | 0.87 | 1M context; thinking and non-thinking modes | Missing |
| `deepseek-chat` | Same as V4 Flash until deprecation | Same | Not separately billed | Same | Compatibility name for V4 Flash non-thinking mode; deprecated on 2026-07-24 at 15:59 UTC | Temporarily correct; should not be retained as a permanent price identity |
| `deepseek-reasoner` | Same as V4 Flash until deprecation | Same | Not separately billed | Same | Compatibility name for V4 Flash thinking mode; same deprecation | Temporarily correct; should not be retained as a permanent price identity |

The official page states that prices may change. No provider cache-write token
price is published; “cache miss” is ordinary input, not prompt-cache creation.

## Z.AI / GLM

Official source: [Z.AI model pricing](https://docs.z.ai/guides/overview/pricing).

### Text models

| Exact API ID | Input | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | --- | ---: | --- | --- |
| `glm-5.2` | 1.40 | 0.26 | Not published; cache storage is temporarily free | 4.40 | Standard API | Correct |
| `glm-5.1` | 1.40 | 0.26 | Same | 4.40 | Standard API | Correct |
| `glm-5-turbo` | 1.20 | 0.24 | Same | 4.00 | Standard API | Correct |
| `glm-5` | 1.00 | 0.20 | Same | 3.20 | Standard API | Correct |
| `glm-4.7` | 0.60 | 0.11 | Same | 2.20 | Standard API | Correct |
| `glm-4.7-flashx` | 0.07 | 0.01 | Same | 0.40 | Standard API | Correct |
| `glm-4.7-flash` | Free | Free | Free | Free | This is a first-party Z.AI free model, not an aggregator promotion | Correct |
| `glm-4.6` | 0.60 | 0.11 | Not published; cache storage is temporarily free | 2.20 | Standard API | Correct |
| `glm-4.5` | 0.60 | 0.11 | Same | 2.20 | Standard API | Correct |
| `glm-4.5-x` | 2.20 | 0.45 | Same | 8.90 | Standard API | Correct |
| `glm-4.5-air` | 0.20 | 0.03 | Same | 1.10 | Standard API | Correct |
| `glm-4.5-airx` | 1.10 | 0.22 | Same | 4.50 | Standard API | Correct |
| `glm-4.5-flash` | Free | Free | Free | Free | First-party Z.AI free model | Correct |
| `glm-4-32b-0414-128k` | 0.10 | Not available | Not available | 0.10 | No cache price published | Correct |

### Vision language models

| Exact API ID | Input | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | --- | ---: | --- | --- |
| `glm-5v-turbo` | 1.20 | 0.24 | Not published; cache storage temporarily free | 4.00 | Vision-language model | Incorrect: broad `glm-5` matches first and returns 1 / 0.20 / 3.20 |
| `glm-4.6v` | 0.30 | 0.05 | Same | 0.90 | Vision-language model | Incorrect: broad `glm-4.6` matches first and returns 0.60 / 0.11 / 2.20 |
| `glm-4.6v-flashx` | 0.04 | 0.004 | Same | 0.40 | Vision-language model | Missing; eventually falls through to unknown `glm` |
| `glm-4.6v-flash` | Free | Free | Free | Free | First-party Z.AI free model | Missing; eventually falls through to unknown `glm` |
| `glm-4.5v` | 0.60 | 0.11 | Same | 1.80 | Vision-language model | Incorrect: broad `glm-4.5` returns output 2.20 |
| `glm-ocr` | 0.03 | Not published | Not published | 0.03 | Official table does not publish a cache rate | Missing |

“Limited-time Free” in the official GLM table applies to cached-input storage.
It does not prove a permanent zero cache-write rate. Image/video/per-request tools
are outside the current token-only cost function; for example, Z.AI web search
is $0.01 per use and must not be folded into token output cost.

## Google Gemini Developer API

Official sources: [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing?hl=en)
and [current Gemini models](https://ai.google.dev/gemini-api/docs/models).

The table below uses Standard paid-tier text/image/video rates. Audio can have a
different input rate and is noted where material. Context caching has a read
price plus a separate storage charge; Google does not publish an Anthropic-style
one-time cache-write token rate.

| Exact API ID | Input | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | --- | ---: | --- | --- |
| `gemini-3.5-flash` | 1.50 | 0.15 | Not published; storage 1.00/M tokens/hour | 9.00 | Audio input differs; Batch/Flex 0.75 / 4.50; Priority 2.70 / 16.20 | Missing; generic `gemini` is unknown |
| `gemini-3.1-flash-lite` | 0.25 | 0.025 | Not published; storage 1.00/M tokens/hour | 1.50 | Audio input 0.50 and cache read 0.05; Batch/Flex halve token rates | Missing |
| `gemini-3.1-pro-preview` | 2.00 / 4.00 | 0.20 / 0.40 | Not published; storage 4.50/M tokens/hour | 12.00 / 18.00 | First number for prompts at most 200k tokens, second above 200k; same prices for `gemini-3.1-pro-preview-customtools` | Missing |
| `gemini-3-flash-preview` | 0.50 | 0.05 | Not published; storage 1.00/M tokens/hour | 3.00 | Audio input 1.00 and cache read 0.10; Batch/Flex 0.25 / 1.50 | Missing |
| `gemini-2.5-pro` | 1.25 / 2.50 | 0.125 / 0.25 | Not published; storage 4.50/M tokens/hour | 10.00 / 15.00 | Threshold is 200k prompt tokens | Missing |
| `gemini-2.5-flash` | 0.30 | 0.03 | Not published; storage 1.00/M tokens/hour | 2.50 | Audio input 1.00 and cache read 0.10 | Missing |
| `gemini-2.5-flash-lite` | 0.10 | 0.01 | Not published; storage 1.00/M tokens/hour | 0.40 | Audio input 0.30 and cache read 0.03 | Missing |
| `gemini-2.5-flash-lite-preview-09-2025` | 0.10 | 0.01 | Not published; storage 1.00/M tokens/hour | 0.40 | Preview model | Missing |

Relevant modality-specific recent models also cannot be represented by one
four-number rate: `gemini-3.1-flash-live-preview`,
`gemini-3.5-live-translate-preview`, `gemini-3.1-flash-image`,
`gemini-3.1-flash-lite-image`, `gemini-3.1-flash-tts-preview`,
`gemini-omni-flash-preview`, and `gemini-3-pro-image` publish different text,
audio, image, or video prices. They should remain explicitly unknown until the
usage schema records token modality. Gemini free-tier access is a quota-bound
first-party tier and must not be encoded as a permanent zero paid-tier price.

## Moonshot AI / Kimi

Official sources: [Kimi model list](https://platform.kimi.ai/docs/models),
[K2.7 Code pricing](https://platform.kimi.ai/docs/pricing/chat-k27-code),
[K2.6 pricing](https://platform.kimi.ai/docs/pricing/chat-k26),
[K2.5 pricing](https://platform.kimi.ai/docs/pricing/chat-k25), and
[Moonshot V1 pricing](https://platform.kimi.ai/docs/pricing/chat-v1).

| Exact API ID | Input, cache miss | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | --- | ---: | --- | --- |
| `kimi-k2.7-code` | 0.95 | 0.19 | Not separately published | 4.00 | 262,144-token context; automatic context caching | Missing; generic `kimi` is unknown |
| `kimi-k2.7-code-highspeed` | 1.90 | 0.38 | Not separately published | 8.00 | Same model, higher-speed service | Missing |
| `kimi-k2.6` | 0.95 | 0.16 | Not separately published | 4.00 | Multimodal, thinking/non-thinking, 262,144-token context | Missing |
| `kimi-k2.5` | 0.60 | 0.10 | Not separately published | 3.00 | Multimodal, thinking/non-thinking, 262,144-token context | Missing |
| `moonshot-v1-8k` and `moonshot-v1-8k-vision-preview` | 0.20 | Not published | Not published | 2.00 | 8,192-token context | Missing |
| `moonshot-v1-32k` and `moonshot-v1-32k-vision-preview` | 1.00 | Not published | Not published | 3.00 | 32,768-token context | Missing |
| `moonshot-v1-128k` and `moonshot-v1-128k-vision-preview` | 2.00 | Not published | Not published | 5.00 | 131,072-token context | Missing |

The official model list says the `kimi-k2` series, including
`kimi-k2-thinking`, was discontinued on 2026-05-25, and `kimi-latest` was
discontinued on 2026-01-28. Aggregator listings that advertise a discontinued
Kimi model as free or at a different price are not Moonshot provider prices and
must not populate this table.

## MiniMax

Official sources: [MiniMax pay-as-you-go pricing](https://platform.minimax.io/docs/guides/pricing-paygo)
and [MiniMax API model overview](https://platform.minimax.io/docs/api-reference/api-overview).

| Exact API ID | Input | Cache read | Cache write | Output | Conditions and modifiers | Current table |
| --- | ---: | ---: | --- | ---: | --- | --- |
| `MiniMax-M3` | 0.30 / 0.60 | 0.06 / 0.12 | Not published | 1.20 / 2.40 | Permanent 50%-off listed price; first tier at most 512k input tokens, second above 512k; 1M context | Missing; generic `minimax` is unknown |
| `MiniMax-M3` with `service_tier: priority` | 0.45 / 0.90 | 0.09 / 0.18 | Not published | 1.80 / 3.60 | Priority admission; 1.5× standard | Cannot be represented by model ID alone |
| `MiniMax-M2.7` | 0.30 | 0.06 | 0.375 | 1.20 | 204,800-token context | Missing |
| `MiniMax-M2.7-highspeed` | 0.60 | 0.06 | 0.375 | 2.40 | Same model with faster service | Missing |
| `MiniMax-M2.5` | 0.30 | 0.03 | 0.375 | 1.20 | Legacy | Missing |
| `MiniMax-M2.5-highspeed` | 0.60 | 0.03 | 0.375 | 2.40 | Legacy | Missing |
| `MiniMax-M2.1` | 0.30 | 0.03 | 0.375 | 1.20 | Legacy | Missing |
| `MiniMax-M2.1-highspeed` | 0.60 | 0.03 | 0.375 | 2.40 | Legacy | Missing |
| `MiniMax-M2` | 0.30 | 0.03 | 0.375 | 1.20 | Legacy | Missing |

The “Permanent 50% off” MiniMax M3 numbers are the currently published
first-party pay-as-you-go rates, not an aggregator discount. The crossed-out
list prices should not be used while MiniMax labels the discount permanent.
Token Plan subscriptions are request/quota products and are not equivalent to
pay-as-you-go token prices.

## Unpublished, variable, and aggregator-only prices

- A provider price is “unknown” when the official provider page does not expose
  a public amount. It must not be replaced with a marketplace average.
- Free OpenRouter or other aggregator variants are promotions or router prices,
  not evidence that the underlying provider API costs zero.
- `big-pickle` has no verified first-party provider price in this audit and is
  correctly left unknown by the current table.
- Negotiated enterprise rates, cloud marketplace premiums, taxes, credit grants,
  subscription quotas, and prepaid packs are account-specific and intentionally
  excluded.

## Implementation implications

Updating numeric constants is necessary but insufficient. A reliable next
version should:

1. resolve exact canonical model IDs before aliases and never use a broad family
   substring when it can collide with another priced model;
2. attach validity dates to temporary prices such as Claude Sonnet 5 and
   compatibility aliases such as `deepseek-chat`;
3. represent context tiers, service tiers, token modality, and cache storage
   separately from the four standard token categories;
4. keep `known: false` for a model whose official price is unpublished instead
   of treating zero as a verified free price;
5. add table-driven tests for exact IDs, aliases, collision cases, price validity
   dates, and explicit free models.
