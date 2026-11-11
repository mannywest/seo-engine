import type { InboxItem } from './types';

/** Sample articles for a made-up car wash, so the screen can be tried with nothing set up. */
export function demoItems(now = new Date()): InboxItem[] {
  const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
  const base = {
    clientId: 'demo',
    tags: ['car wash', 'west london'],
    sources: [
      { title: 'Park Royal Wash: our services', url: 'https://example.com/services' },
      { title: 'Notes from the owner', url: 'https://example.com/notes' },
    ],
  };
  return [
    {
      ...base,
      id: 'how-often-should-you-wash-your-car',
      addedAt: ago(3),
      status: 'waiting',
      reason: 'Ready for your approval.',
      title: 'How often should you wash your car?',
      description: 'A plain guide to how often a car needs washing, and what changes in winter, for drivers around west London.',
      topic: { title: 'How often should you wash your car?', slug: 'how-often-should-you-wash-your-car', keyword: 'how often to wash a car', intent: 'info', outline: ['The short answer', 'Winter', 'Salt and grime', 'When to book'] },
      quality: { passed: true, score: 91, issues: [], warnings: ['No outbound links to sources.'] },
      body: `## The short answer\n\nFor most drivers, a wash every two weeks keeps paint and glass in good shape. If your car sits outside or you drive on salted roads, wash it weekly.\n\n## Why winter is different\n\nRoad salt and grit stick to the underside and the lower panels. Left alone, they work into the paint.\n\n- Rinse the underside after salted roads\n- Wash wheels and arches more often\n- Dry the door seals so they do not freeze shut\n\n## When to book a proper clean\n\n1. After a long motorway trip\n2. Before you sell the car\n3. When the paint feels rough to the touch\n\nOur team can do a full hand wash and interior valet in about an hour.`,
    },
    {
      ...base,
      id: 'ceramic-coating-worth-it',
      addedAt: ago(26),
      status: 'waiting',
      reason: 'Needs a look first: 2 problems found by the automatic checks.',
      title: 'Is a ceramic coating worth it?',
      description: 'What a ceramic coating does, how long it lasts, and who it makes sense for.',
      topic: { title: 'Is a ceramic coating worth it?', slug: 'ceramic-coating-worth-it', keyword: 'ceramic coating worth it', intent: 'commercial', outline: ['What it is', 'Cost', 'How long it lasts'] },
      quality: {
        passed: false,
        score: 54,
        issues: ['"Lasts up to 9 years" is not in any source we read.', 'The price of £450 does not match the services page.'],
        warnings: ['Two sentences are hard to read (Flesch 38).'],
      },
      body: `## What a ceramic coating is\n\nA ceramic coating is a thin layer that bonds to the paint and makes it easier to clean.\n\n## What it costs and how long it lasts\n\nA coating from us costs £450 and lasts up to 9 years.\n\nIt will not stop stone chips, and it still needs regular washing.`,
    },
    {
      ...base,
      id: 'interior-valet-checklist',
      addedAt: ago(30),
      status: 'approved',
      reason: 'Ready for your approval.',
      title: 'What is included in an interior valet?',
      description: 'A checklist of what a proper interior valet covers.',
      topic: { title: 'What is included in an interior valet?', slug: 'interior-valet-checklist', keyword: 'interior valet', intent: 'info', outline: ['Checklist'] },
      quality: { passed: true, score: 94, issues: [], warnings: [] },
      body: `## The checklist\n\n- Vacuum seats, boot and carpets\n- Clean dashboard and door cards\n- Clean windows inside`,
      decidedAt: ago(5),
      decidedBy: 'you@demo',
    },
    {
      ...base,
      id: 'winter-wash-tips',
      addedAt: ago(100),
      status: 'published',
      reason: 'Ready for your approval.',
      title: 'Five winter car wash tips',
      description: 'Five quick ways to protect your car from salt and grit.',
      topic: { title: 'Five winter car wash tips', slug: 'winter-wash-tips', keyword: 'winter car wash', intent: 'info', outline: ['Tips'] },
      quality: { passed: true, score: 96, issues: [], warnings: [] },
      body: `## Five tips\n\n1. Wash weekly\n2. Rinse the underside\n3. Dry the seals\n4. Use a wax\n5. Clean the wheels`,
      decidedAt: ago(80),
      decidedBy: 'you@demo',
      deliveredTo: 'https://example.com/blog/winter-wash-tips',
    },
    {
      ...base,
      id: 'cheapest-car-wash',
      addedAt: ago(120),
      status: 'rejected',
      reason: 'Needs a look first: 1 problem found by the automatic checks.',
      title: 'The cheapest car wash in London',
      description: 'A look at the cheapest wash.',
      topic: { title: 'The cheapest car wash in London', slug: 'cheapest-car-wash', keyword: 'cheapest car wash', intent: 'commercial', outline: ['Prices'] },
      quality: { passed: false, score: 40, issues: ['Claims we are the cheapest, which we cannot show.'], warnings: [] },
      body: `## Prices\n\nWe are the cheapest in London.`,
      decidedAt: ago(100),
      decidedBy: 'you@demo',
      note: 'We cannot prove that claim.',
    },
  ];
}
