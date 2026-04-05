# Common Patterns & Conventions

> This file is loaded on-demand. Referenced from CLAUDE.md.

## Tailwind CSS Design Tokens

Use `aap-*` tokens for all new UI. Run `npm run css:build` after adding new classes.

| Token | Usage |
|-------|-------|
| `bg-aap-cream` | Page/card backgrounds |
| `bg-aap-dark` | Dark sections, headers |
| `text-aap-amber` | Accent text, links |
| `shadow-aap` | Card shadows |
| `rounded-aap` | Border radius |

## Fetching Spaces with Media
```javascript
const { data } = await supabase
  .from('spaces')
  .select(`
    *,
    media_spaces(display_order, is_primary, media:media_id(id, url, caption))
  `)
  .eq('can_be_dwelling', true)
  .order('monthly_rate', { ascending: false, nullsFirst: false });
```

## Computing Availability
```javascript
const { data: assignments } = await supabase
  .from('assignments')
  .select('id, start_date, end_date, desired_departure_date, desired_departure_listed, status, assignment_spaces(space_id)')
  .in('status', ['active', 'pending_contract', 'contract_sent']);

// Note: Only use desired_departure_date if desired_departure_listed is true
const currentAssignment = spaceAssignments.find(a => {
  if (a.status !== 'active') return false;
  const effectiveEndDate = (a.desired_departure_listed && a.desired_departure_date) || a.end_date;
  if (!effectiveEndDate) return true;
  return new Date(effectiveEndDate) >= today;
});
space.isAvailable = !currentAssignment;
```

## Uploading Media
```javascript
import { mediaService } from '../shared/media-service.js';
const media = await mediaService.uploadMedia(file, { category: 'mktg', caption: 'Room photo' });
await mediaService.linkMediaToSpace(media.id, spaceId, displayOrder);
```

## Building Mobile App
```bash
cd mobile
npm run sync            # Full rebuild + sync to both platforms
npm run sync:ios        # Sync to one platform only
npm run open:ios        # Opens Xcode — press Play (▶) to run
npm run open:android    # Opens Android Studio — press Run
```

## Adding a New Mobile Tab Module
```javascript
// mobile/app/tabs/example-tab.js
import { ExampleService } from '../../../shared/services/example-data.js';
import { PollManager } from '../../../shared/services/poll-manager.js';
let poll;
export async function init(appUser) {
  const container = document.getElementById('exampleContent');
  poll = new PollManager(() => refreshData(), 30000);
  poll.start();
}
```

## Sending SMS
```javascript
import { smsService } from '../shared/sms-service.js';
await smsService.sendPaymentReminder(tenant, amount, dueDate, period);
await smsService.sendGeneral(tenant, "Your package arrived.");
await smsService.sendBulk('bulk_announcement', recipients, { message: "..." });
const messages = await smsService.getConversation(personId);
```

## Sorting & Display Rules

### Consumer View
1. Available spaces first (isAvailable = true)
2. Then by monthly_rate descending (highest price first)
3. Then by name alphabetically

### Admin View
1. By monthly_rate descending, then by name

### Availability Display
- Available now: "Available: NOW"
- Occupied with end date: "Available: Mar 15"
- Occupied indefinitely: "Available: TBD"

## Testing Changes

1. Check both card view and table view in consumer and admin views
2. Test on mobile web (responsive breakpoint at 768px)
3. Verify availability badges show correct dates
4. **Mobile app**: After changing `shared/services/` or `mobile/app/` files, rebuild with `cd mobile && npm run sync`
5. **Mobile app login**: Test both email/password and Google Sign In on both platforms

### Email Template Previewing

**Do NOT send real emails while iterating on email template design.** Resend has a daily quota. Write HTML to `tmp-invite-preview.html` and open in browser. Only send once design is finalized.

### Financial Content Typography

**All financial/money-related content must use sans-serif fonts** (e.g., `'Inter', 'Helvetica Neue', Arial, sans-serif`). This applies to:
- Move-out statements, invoices, payment summaries
- Ledger tables, rent charges, refund summaries
- Any email or UI displaying dollar amounts, accounting, or transaction data

Serif fonts (Georgia, Times) are reserved for editorial/marketing content only.
