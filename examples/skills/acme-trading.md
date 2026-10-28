---
name: acme-trading
description: How Acme Trading uses ERPNext - names, warehouses, buying and selling rules, custom fields
---

# Acme Trading: how we use ERPNext

We're a small trading company. We buy industrial fasteners from two suppliers and sell to hardware shops.
Most staff are new to ERPNext; explain in our words.

## Our words → ERPNext
- "Indent" or "purchase request" = **Material Request** (type Purchase).
- "GRN" = **Purchase Receipt**. "Challan" = **Delivery Note**.
- "Party" means a Customer when we sell and a Supplier when we buy.

## Warehouses
- **Main Godown - AT**: everything we buy lands here.
- **Showroom - AT**: small stock for walk-in sales. Move stock with a Material Transfer.
- Never use "Stores - AT"; it's left over from setup.

## Buying
1. Store keeper raises a Material Request.
2. Purchase head turns it into a Purchase Order. POs above ₹50,000 need the director's approval (workflow).
3. Goods arrive → Purchase Receipt into Main Godown → Purchase Invoice when the bill comes.

## Selling
- Every customer has a **Credit Days** custom field (on Customer, Details tab). Respect it in payment terms.
- Shops in Mumbai get the "Mumbai Retail" price list; everyone else "Standard Selling".
- We never invoice without a Delivery Note.

## Custom fields we added
- Customer → `whatsapp_number` (Data): we send order updates on WhatsApp.
- Item → `brand_family` (Select: Hex, Socket, Self-tapping).
