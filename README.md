# Zeliks Engine

One assistant engine that serves many businesses. Each business gets a small
config pack (a JSON file in this repo) that says who they are, what they sell,
and which tools are switched on. The engine reads the pack, talks to the
customer, captures leads, takes bookings, and reports back to the owner at
the end of the day.

This repo holds the design and the parts that do not depend on a live server:
the database schema, the config pack format, the prompt builder, the n8n
workflow definitions, and the test conversations. The running system (where
n8n lives, the Telegram door, the connection to the AI model) is wired up in
a later phase. See "Not yet built" below.

## Architecture

```
            customer message (any channel)
                      |
                      v
             workflows/chat_entry.json
        normalizes to {tenant_id, customer_id, text}
                      |
        +-------------+--------------+
        |                            |
        v                            v
   AI agent (free)            booking intent detected
   questions and              |
   qualification              v
        |              workflows/booking_state_machine.json
        |              collect -> check -> confirm -> write
        |                            |
        +-------------+--------------+
                      v
              Postgres (register)
          leads, bookings, messages,
          follow-ups, daily summaries
                      |
        +-------------+--------------+
        v                            v
 workflows/followup.json     workflows/evening_summary.json
 nudge when a lead goes      one summary to the owner
 quiet                       at close of day
```

## Settled decisions, and why

These were agreed with the business owner and checked against how comparable
products are built. Do not re-litigate them inside this repo; change them by
editing this file in a reviewed commit.

1. **One engine plus a toolbox plus a config pack per business.**
   The engine code and workflows are shared. Everything that differs between
   businesses lives in the pack. Adding a business never means copying a
   workflow.

2. **Hybrid conversation flow.**
   The AI agent is free only where freedom is safe: answering questions from
   the business's own information and qualifying the lead. Booking is not
   free conversation. It runs as a state machine: collect the details, check
   availability in code, ask the customer to confirm explicitly, then write
   the booking once, in a way that cannot create a duplicate. Reminders and
   the evening summary are fully deterministic. No AI writes them.

3. **Postgres from day one, one shared database, tenant_id on every table.**
   Tenant isolation is enforced inside the queries themselves: every read
   and write carries `WHERE tenant_id = $tenant`. We never fetch rows and
   filter them afterwards. Google Sheets is only ever a read-only view of
   the register for a client who wants to peek. It is never the store,
   because it has no transactions and cannot stop two bookings landing on
   the same slot.

4. **Config packs are JSON files in Git, validated against a schema.**
   A pack change is a commit: reviewed, reversible, and visible in history.
   `packs/schema.json` defines the shape; `packs/` holds one file per
   business. A pack that fails validation does not ship.

5. **A tool is on because it is registered, not because the prompt says so.**
   The pack lists which tools are on for that business. At runtime the
   engine registers exactly those tools for the session. A tool that is off
   does not exist for that tenant, so the model cannot call it by accident
   or by persuasion.

6. **The system prompt is assembled from the pack by a builder.**
   Nobody hand-edits a live prompt. `prompts/build_prompt.py` takes a pack
   and produces the final prompt from `prompts/system_prompt_template.md`.
   The prompt stays small on purpose: business facts, rules, and the tool
   list. The full FAQ set is not stuffed into the prompt; the agent looks
   answers up through the `answer` tool instead.

7. **n8n is the orchestration layer, designed so it can be replaced.**
   Workflows live in `workflows/` as importable JSON. The exit path to
   plain code stays open because of three habits: prompts and packs are
   files in this repo (not strings buried in a database), every tool is a
   small contract with named inputs and outputs, and all state lives in
   Postgres, not in n8n's memory.

## Repo layout

```
db/schema.sql               Postgres tables, indexes, uniqueness guards
db/notes.md                 how availability check and idempotent booking work
packs/schema.json           JSON Schema every config pack must pass
packs/luxe-locks-salon.json first pack: a fictional salon in Austin, Texas
prompts/system_prompt_template.md   prompt skeleton with pack placeholders
prompts/build_prompt.py     assembles a pack into a final system prompt
prompts/examples/           generated prompts, committed as proof
workflows/                  n8n workflow definitions (importable JSON)
tests/conversations.md      scripted conversations with pass criteria
```

## How a new business gets onboarded

1. Write the pack: copy an existing file in `packs/`, fill in the business
   facts (services, prices, hours, FAQs), and set the tool switches.
2. Validate it: `python3 -m jsonschema -i packs/<business>.json packs/schema.json`
   (or any JSON Schema validator).
3. Add the tenant row in Postgres with the same slug as the pack file name.
   That slug is the `tenant_id` used everywhere.
4. Generate the prompt: `python3 prompts/build_prompt.py packs/<business>.json`
5. Import the workflows once (they are shared across tenants). The tenant's
   channel (Telegram first) is pointed at the chat entry workflow with the
   tenant's slug attached to every incoming message.
6. Run through `tests/conversations.md` against the new pack before calls
   it live. A pack does not go live on a workflow change alone.

## Not yet built

- **Runtime placement.** Where the isolated n8n instance and Postgres live.
  Deliberately untouched in this phase: no server changes, no new services.
- **Telegram door.** The bot attaches to `workflows/chat_entry.json`. Needs
  a bot token from the owner. The workflow itself is channel-agnostic: it
  takes a normalized message, so WhatsApp or a website chat can be attached
  later without touching the engine.
- **Vertex AI wiring.** The AI agent's model (Gemini via Vertex AI) plugs
  into clearly labelled placeholder nodes in the workflows. No credentials
  exist in this repo and none should ever be committed.
- **Sheets view.** The read-only Google Sheets view of the register for
  clients. Optional, later, and never a data store.
- **Owner alert delivery.** The alert step exists in the booking workflow
  and writes to the register. The channel the owner actually receives it on
  is chosen per business in the runtime phase.
