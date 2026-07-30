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
jq -nc --arg text "$item_text" '{text:$text}' |
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
jq -nc --argjson completed true '{completed:$completed}' |
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
  --data '{}' \
  "http://127.0.0.1:18890/shopping/items/$encoded_id"
```

## Clear completed items

Confirm before clearing multiple completed items.

```bash
curl -fsS --max-time 20 -X POST \
  -H 'Content-Type: application/json' \
  --data '{}' \
  http://127.0.0.1:18890/shopping/clear-completed
```

## Response style

- For a successful single write, respond naturally and briefly.
- When reading the list, omit completed items unless the user asks for them.
- For recipe or meal-plan requests, derive the proposed ingredients, read the
  current list, avoid obvious duplicates, then add the remaining items.
- Never mention internal IDs or adapter details to the user.
