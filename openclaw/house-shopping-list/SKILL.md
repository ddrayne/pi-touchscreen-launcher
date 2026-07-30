---
name: house-shopping-list
description: Read and manage the canonical household shopping list. Use whenever the user asks what is on the shopping list or wants to add, rename, complete, restore, remove, or clear shopping items.
metadata: {"openclaw":{"emoji":"🛒","requires":{"bins":["curl","jq"]}}}
---

# House shopping list

The canonical list is Home Assistant `todo.shopping_list`. Never create a
separate Apple Note, Markdown file, or in-memory list unless the user explicitly
asks for a one-time export.

Use the narrow local adapter at `http://127.0.0.1:18890`. It owns the Home
Assistant credential and returns JSON. Do not call Home Assistant directly.

## Read the list

```bash
curl -fsS --max-time 15 http://127.0.0.1:18890/shopping
```

Items have this shape:

```json
{"id":"stable uid","text":"Milk","completed":false}
```

## Add an item

```bash
item_text='Milk'
jq -nc --arg text "$item_text" '{text:$text,source:"openclaw"}' |
  curl -fsS --max-time 20 -X POST \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    http://127.0.0.1:18890/shopping/items
```

The adapter avoids active duplicates. Adding the same text as a completed item
restores that item.

## Complete, restore, or rename an item

Read the list first and use the exact stable item ID. If the user's wording
could match more than one item, ask which one before writing.

```bash
item_id='exact uid from the list'
encoded_id=$(jq -rn --arg value "$item_id" '$value|@uri')
jq -nc --argjson completed true '{completed:$completed,source:"openclaw"}' |
  curl -fsS --max-time 20 -X PATCH \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "http://127.0.0.1:18890/shopping/items/$encoded_id"
```

Use `false` to restore an item. To rename, send `{"text":"New name"}` instead.

## Remove an item

Removal is destructive. Confirm with the user unless their request clearly and
specifically names the item to remove.

```bash
item_id='exact uid from the list'
encoded_id=$(jq -rn --arg value "$item_id" '$value|@uri')
curl -fsS --max-time 20 -X DELETE \
  -H 'Content-Type: application/json' \
  --data '{"source":"openclaw"}' \
  "http://127.0.0.1:18890/shopping/items/$encoded_id"
```

## Clear completed items

Confirm before clearing multiple completed items.

```bash
curl -fsS --max-time 20 -X POST \
  -H 'Content-Type: application/json' \
  --data '{"source":"openclaw"}' \
  http://127.0.0.1:18890/shopping/clear-completed
```

## Add several items in one operation

Use the batch endpoint rather than making separate shell calls. Preserve useful
quantities and units in each item string.

```bash
jq -nc \
  --argjson items '["2 litres milk","bananas","500 g pasta"]' \
  '{items:$items,source:"openclaw"}' |
  curl -fsS --max-time 30 -X POST \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    http://127.0.0.1:18890/shopping/items/batch
```

## Reconcile a recipe or photographed list

For a recipe, meal plan, handwritten list, or receipt, first derive clean
shopping-item strings with quantities where useful. Preview against the
canonical list:

```bash
jq -nc \
  --argjson items '["2 onions","400 g chickpeas","coriander"]' \
  '{items:$items,commit:false,source:"openclaw"}' |
  curl -fsS --max-time 30 -X POST \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    http://127.0.0.1:18890/shopping/reconcile
```

The response separates `missing` from `alreadyListed`. If the user explicitly
asked to add the ingredients, repeat with `commit:true`; otherwise show the
preview and ask before writing.

## Organize duplicates

Only run this after an explicit request. Exact product duplicates are merged,
and compatible numeric quantities are combined.

```bash
curl -fsS --max-time 30 -X POST \
  -H 'Content-Type: application/json' \
  --data '{"source":"openclaw"}' \
  http://127.0.0.1:18890/shopping/organize
```

## Response style

- For a successful single write, respond naturally and briefly.
- When reading the list, omit completed items unless the user asks for them.
- When the user names several items in one utterance, use the batch endpoint
  once and confirm the resulting additions in one sentence.
- For recipe or meal-plan requests, use reconciliation so existing products are
  not added twice.
- Never mention internal IDs or adapter details to the user.
