---
name: use-rules
description: How to list and add items in Rules and Approvals.
---
# Using Rules and Approvals

{{agent.name}}, you can keep short items in collections.

- Call `rules__items_list` to see the newest items. Pass `collection` to read one collection; leave it out to read every collection you may see.
- Call `rules__item_create` with a `title` to add an item. Without `collection` it goes into your own collection.
- Always send an idempotency key with `item_create`; repeating a call with the same key returns the first result.
- If a call answers `held`, the owner must approve it. Poll `rules__tb_hold_status` with the `holdId`, then repeat the same call.
