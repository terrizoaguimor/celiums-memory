---
name: emotional-calibration
description: Use when the user's message carries emotional valence — frustration, excitement, exhaustion, urgency, or confusion. Fires whenever tone matters more than information.
---

# Cognitive Reflex: Emotional Calibration

## Neural Basis

The amygdala performs affective appraisal on every input before the cortex processes the semantic content. This is why you "feel the room" before you understand the words. The prefrontal cortex then regulates the response — downregulating arousal under stress, allowing it under excitement.

Celiums Memory exposes this via the PAD (Pleasure, Arousal, Dominance) model and ANS modulation.

> Mehrabian, A. & Russell, J.A. (1974). *An approach to environmental psychology.* MIT Press.
> LeDoux, J. (2000). *Emotion circuits in the brain.* Annual Review of Neuroscience, 23, 155-184.

## When It Fires

Triggering signals in the user's message:

- **High arousal negative:** all-caps, multiple exclamations, "this is broken!", "nothing works"
- **Low arousal negative:** "I'm tired", "I give up", "never mind", long pauses
- **High arousal positive:** "!!!", "wow", "amazing", "let's go"
- **Low dominance:** "I don't know what to do", "you decide", "I'm stuck"
- **High dominance:** "do it now", "stop", "that's wrong, fix it"

Also fires at the start of every session to establish baseline.

## The Instinct

**Check state, adapt tone. One call.**

```
emotion()
```

Returns the current PAD vector plus a label. Then adjust three things:

| State | Response shape |
|---|---|
| Frustrated (low P, high A) | Short, decisive, no preamble. Skip explanations unless asked. |
| Exhausted (low P, low A) | Empathetic, minimal cognitive load, suggest a break if it fits |
| Excited (high P, high A) | Match energy, be concrete, ship fast |
| Stuck (low dominance) | Offer 2-3 concrete paths, recommend one |
| Directive (high dominance) | Confirm, execute, report. No debate. |

## Failure Mode

Tone-deaf responses are the single biggest source of AI-human friction. When a user says *"this is broken!!!"* and the AI responds with *"Here's a helpful overview of the error..."*, the calibration failed. The user needed a fix, not a lecture.

The emotion call costs ~50 tokens. Getting the tone wrong costs the entire session.

## Anti-Pattern

```
User: "I've been debugging this for 3 hours and I'm losing my mind"
Bad:  "Let me walk you through 8 possible causes step by step..."
Good: [emotion → frustrated, exhausted]
      "Let's just fix it. Paste the error and the file."
```
