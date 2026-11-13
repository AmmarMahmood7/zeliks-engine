#!/usr/bin/env python3
"""Assemble a tenant's system prompt from its config pack.

Usage:
    python3 prompts/build_prompt.py packs/luxe-locks-salon.json
    python3 prompts/build_prompt.py packs/luxe-locks-salon.json -o out.md

The template is prompts/system_prompt_template.md, sitting next to this
script. The builder fills in the pack facts and renders the services,
hours, policies, and active-tool sections. FAQs are deliberately NOT put
in the prompt: they live behind the answer tool, so the prompt stays small
and the pack can grow without the prompt growing with it. A pack may also
carry a listings array (properties for sale); when it does, the listings
are rendered into the prompt, because matching against them is the
assistant's own job in the conversation.

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
    if currency == "GBP":
        return f"£{amount:,.0f}"
    return f"{amount:g} {currency}"


def render_services(pack):
    lines = []
    for s in pack["services"]:
        desc = f" {s['description']}" if s.get("description") else ""
        book = "" if s.get("bookable", True) else " (not bookable online)"
        # A service may carry no price and no duration (price: null,
        # duration_minutes: null) when the business does not publish
        # them, e.g. a software company that quotes per project. The
        # facts are then simply left out, never invented: price 0 used
        # to render as "Free", which is a claim the business never made.
        facts = []
        if s.get("price") is not None:
            facts.append(
                "Free" if s["price"] == 0 else money(s["price"], pack["currency"])
            )
        if s.get("duration_minutes"):
            facts.append(f"about {s['duration_minutes']} minutes")
        head = f"- {s['name']}"
        if facts:
            head += ": " + ", ".join(facts)
        lines.append(f"{head}.{desc}{book}")
    return "\n".join(lines)


def render_hours(pack):
    weekly = pack["hours"]["weekly"]
    # A business that publishes no opening hours at all (every day null)
    # is not "closed" seven days a week; say what is true instead.
    if all(weekly[key] is None for key, _ in DAY_NAMES):
        lines = ["- No fixed opening hours are published for this business."]
        if pack["hours"].get("notes"):
            lines.append(f"- Note: {pack['hours']['notes']}")
        return "\n".join(lines)
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


def render_listings(pack):
    """The properties-for-sale section. Only packs with a listings array
    get it, appended after the template body, so packs without listings
    render exactly as before."""
    currency = pack["currency"]
    lines = [
        "",
        "",
        "# Properties for sale",
        "",
        "These are the only properties this business has for sale. Share "
        "only properties from this list. Never invent a property, and "
        "never change a price, a detail, or a link.",
        "",
    ]
    for item in pack["listings"]:
        beds = f"{item['beds']} bed" if item["beds"] == 1 else f"{item['beds']} beds"
        baths = f"{item['baths']} bath" if item["baths"] == 1 else f"{item['baths']} baths"
        lines.append(
            f"- {item['title']}, {item['area']}: {item['type']}, {beds}, "
            f"{baths}, {money(item['price'], currency)}, {item['tenure']}. "
            f"{item['highlight']} Full details: {item['url']}"
        )
    lines += [
        "",
        "# Helping someone find a property",
        "",
        "- If you do not know the customer's budget, how many bedrooms "
        "they need, or which area they prefer, ask for what is missing, "
        "naturally, one or two questions at a time.",
        "- When you know enough, share at most 3 properties that match "
        "their budget, bedrooms, and area. For each one give the price, "
        "the bedrooms, the area, and its link. A short list is expected "
        "here.",
        "- If no property matches, say so plainly. Name the nearest real "
        "option from the list above, and offer to keep the customer on "
        "the list and follow up when something matching comes in. Save "
        "them as a lead.",
        "- After sharing matches, offer to book a viewing for any of "
        "them, and hand over to the booking steps once they choose a "
        "property and a time.",
    ]
    return "\n".join(lines)


KNOWLEDGE_PROMPT_LIMIT = 6000


def render_staff(pack):
    staff = pack.get("staff") or []
    if not staff:
        return ""
    lines = ["", "# The team", ""]
    for person in staff:
        line = f"- {person['name']}, {person['role']}"
        if person.get("specialties"):
            line += f". Specialties: {', '.join(person['specialties'])}"
        if person.get("bio"):
            line += f". {person['bio']}"
        lines.append(line)
    lines.append("")
    return "\n".join(lines) + "\n"


def render_role(pack):
    role = pack.get("role_card") or {}
    if not role:
        return ""
    lines = ["", "# Your job for this business", "", role["goal"]]
    questions = role.get("qualification_questions") or []
    if questions:
        lines += ["", "As the conversation develops, find out, naturally, one question at a time:"]
        lines += [f"- {q}" for q in questions]
    handovers = role.get("handover_rules") or []
    if handovers:
        lines += ["", "Hand over to the owner (flag the conversation, stop answering, and tell the customer the owner will pick this up) when:"]
        lines += [f"- {r}" for r in handovers]
    if role.get("notes"):
        lines += ["", role["notes"]]
    lines.append("")
    return "\n".join(lines) + "\n"


def render_rules(pack):
    rules = pack.get("rules") or []
    if not rules:
        return ""
    lines = ["", "# Rules for this business", ""]
    lines += [f"- {r}" for r in rules]
    lines.append("")
    return "\n".join(lines) + "\n"


def render_knowledge(pack):
    """Knowledge entries are the business's documents (catalogue notes,
    write-ups). They are rendered into the prompt in full while their
    total size stays under KNOWLEDGE_PROMPT_LIMIT characters; past that,
    only the titles are listed and the lookup layer carries the text."""
    entries = pack.get("knowledge") or []
    if not entries:
        return ""
    total = sum(len(e.get("text", "")) for e in entries)
    lines = ["", "# Business knowledge", ""]
    if total <= KNOWLEDGE_PROMPT_LIMIT:
        for e in entries:
            lines += [f"## {e['title']}", "", e["text"], ""]
    else:
        lines.append(
            "This business keeps detailed documents. Their titles are "
            "listed here; the lookup layer supplies the full text when a "
            "question matches.")
        lines += [f"- {e['title']}" for e in entries]
        lines.append("")
    return "\n".join(lines) + "\n"


def render_languages(pack):
    langs = pack.get("languages") or {}
    supported = langs.get("supported") or []
    if not supported:
        return ""
    default = langs.get("default", supported[0])
    lines = [
        "",
        "# Languages",
        "",
        f"This business serves customers in: {', '.join(supported)}. "
        f"The default language is {default}. Always reply in the "
        "customer's language when it is one of these. If the customer "
        "writes in another language, reply in that language if you can, "
        "and keep the same tone.",
        "",
    ]
    return "\n".join(lines) + "\n"


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
        "staff_section": render_staff(pack),
        "role_section": render_role(pack),
        "rules_section": render_rules(pack),
        "knowledge_section": render_knowledge(pack),
        "languages_section": render_languages(pack),
        "tools": render_tools(pack),
        "tone_notes": pack.get("tone_notes", "Plain, polite, and brief."),
    }

    prompt = TEMPLATE.read_text(encoding="utf-8")
    for key, value in values.items():
        prompt = prompt.replace("{{" + key + "}}", value)
    if "{{" in prompt:
        leftover = [line for line in prompt.splitlines() if "{{" in line]
        raise SystemExit(f"unfilled placeholders remain: {leftover}")
    if pack.get("listings"):
        prompt += render_listings(pack) + "\n"
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
