#!/usr/bin/env python3
"""Assemble a tenant's system prompt from its config pack.

Usage:
    python3 prompts/build_prompt.py packs/luxe-locks-salon.json
    python3 prompts/build_prompt.py packs/luxe-locks-salon.json -o out.md

The template is prompts/system_prompt_template.md, sitting next to this
script. The builder fills in the pack facts and renders the services,
hours, policies, and active-tool sections. FAQs are deliberately NOT put
in the prompt: they live behind the answer tool, so the prompt stays small
and the pack can grow without the prompt growing with it.

Exit code is non-zero if the pack is missing a required field or if any
template placeholder is left unfilled.
"""
import argparse
import json
import sys
from pathlib import Path

TEMPLATE = Path(__file__).with_name("system_prompt_template.md")

TOOL_LINES = {
    "answer": (
        "- answer(question): look up the business's FAQs and facts. "
        "Returns the matching answer, or nothing when there is no match."
    ),
    "lead_capture": (
        "- lead_capture(name, phone, need): save or update this customer "
        "as a lead in the register. Call it as soon as you have the three "
        "pieces, and again if any of them changes."
    ),
    "booking": (
        "- booking_handoff(service, starts_at, name, phone): hand the "
        "conversation to the booking steps with the details you collected. "
        "The booking is only real once the booking steps confirm it back "
        "to you; never tell the customer they are booked before that."
    ),
    "follow_up": (
        "- follow_up is automatic and not yours to send: if this customer "
        "goes quiet, the system schedules one polite nudge on its own."
    ),
    "owner_alert": (
        "- owner_alert(summary): send a short note to the owner and flag "
        "this conversation for a human. Use it when you cannot answer, "
        "when the customer asks for a person, or when something looks off."
    ),
    "evening_summary": (
        "- evening_summary is automatic: the owner gets one summary of "
        "the day at closing time. You do not write it."
    ),
}

DAY_NAMES = [
    ("mon", "Monday"),
    ("tue", "Tuesday"),
    ("wed", "Wednesday"),
    ("thu", "Thursday"),
    ("fri", "Friday"),
    ("sat", "Saturday"),
    ("sun", "Sunday"),
]


def money(amount, currency):
    if currency == "USD":
        return f"${amount:g}"
    return f"{amount:g} {currency}"


def render_services(pack):
    lines = []
    for s in pack["services"]:
        desc = f" {s['description']}" if s.get("description") else ""
        book = "" if s.get("bookable", True) else " (not bookable online)"
        lines.append(
            f"- {s['name']}: {money(s['price'], pack['currency'])}, "
            f"about {s['duration_minutes']} minutes.{desc}{book}"
        )
    return "\n".join(lines)


def render_hours(pack):
    weekly = pack["hours"]["weekly"]
    lines = []
    for key, name in DAY_NAMES:
        day = weekly[key]
        if day is None:
            lines.append(f"- {name}: closed")
        else:
            lines.append(f"- {name}: {day['open']} to {day['close']}")
    if pack["hours"].get("notes"):
        lines.append(f"- Note: {pack['hours']['notes']}")
    return "\n".join(lines)


def render_policies(pack):
    labels = {
        "cancellation": "Cancellation",
        "late_arrival": "Running late",
        "walk_ins": "Walk-ins",
    }
    lines = [
        f"- {labels.get(k, k)}: {v}"
        for k, v in pack.get("policies", {}).items()
        if v
    ]
    return "\n".join(lines) if lines else "- No written policies in the pack."


def render_tools(pack):
    active = [name for name, on in pack["tools"].items() if on]
    return "\n".join(TOOL_LINES[name] for name in active)


def build(pack):
    required = ["tenant_id", "business", "currency", "services", "hours", "tools"]
    missing = [k for k in required if k not in pack]
    if missing:
        raise SystemExit(f"pack is missing required fields: {', '.join(missing)}")

    biz = pack["business"]
    values = {
        "business_name": biz["name"],
        "business_type": biz["type"],
        "area": biz["area"],
        "address": biz.get("address", "Ask the business"),
        "phone": biz.get("phone", "Ask the business"),
        "timezone": biz["timezone"],
        "services": render_services(pack),
        "hours": render_hours(pack),
        "payment_notes": pack.get("payment_notes", "Ask the business."),
        "policies": render_policies(pack),
        "tools": render_tools(pack),
        "tone_notes": pack.get("tone_notes", "Plain, polite, and brief."),
    }

    prompt = TEMPLATE.read_text(encoding="utf-8")
    for key, value in values.items():
        prompt = prompt.replace("{{" + key + "}}", value)
    if "{{" in prompt:
        leftover = [line for line in prompt.splitlines() if "{{" in line]
        raise SystemExit(f"unfilled placeholders remain: {leftover}")
    header = (
        f"<!-- Generated by prompts/build_prompt.py from pack "
        f"'{pack['tenant_id']}'. Do not edit by hand; edit the pack. -->\n\n"
    )
    return header + prompt


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pack", help="path to a config pack JSON file")
    ap.add_argument("-o", "--out", help="write here instead of stdout")
    args = ap.parse_args()

    pack = json.loads(Path(args.pack).read_text(encoding="utf-8"))
    prompt = build(pack)
    if args.out:
        Path(args.out).write_text(prompt, encoding="utf-8")
        print(f"wrote {args.out} ({len(prompt)} chars) for tenant {pack['tenant_id']}")
    else:
        sys.stdout.write(prompt)


if __name__ == "__main__":
    main()
