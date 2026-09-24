// Guided tour and primer. The tour is an ordinary board: a worked example
// whose walkthrough steps each carry a short "How this works" note, so the
// thing being explained is the thing on screen. Delete it like any board.

const TOUR_TITLE = 'Guided example: How can I get health insurance now?';
const SVS = 'https://www.svs.at/cdscontent/?contentid=';

// Keyed by card id; shown beside the matching walkthrough step.
const TIPS = {
  'guide-f1': ['Facts: your situation', 'Grey cards are <b>facts</b> about you. They are the starting point, and no rule proves them. Everything later in the argument depends on them, so a reader can check them first.'],
  'guide-f2': ['Facts narrow the rules', 'A second fact. Facts decide which rules apply: change one and the claims that follow may no longer hold.'],
  'guide-c1': ['Claims need evidence', 'White cards are <b>claims</b>: what a rule says, in your own words. The card below it is <b>evidence</b>: the exact words copied from the source. <b>Open at passage ↗</b> opens the page scrolled to that sentence and highlighted, so nobody has to hunt for it.'],
  'guide-old': ['Objections stay visible', 'This claim has an <b>objection</b>: the evidence below says otherwise (red dashed line on the board). Keep ruled-out assumptions on the board instead of deleting them, so a reader can see what you considered and why it failed.'],
  'guide-c2': ['Arrows read as sentences', 'Every arrow on the board reads like something you would say: “[this card] <b>because</b> [that card]”, “… <b>so</b> …”, “… <b>but</b> …”. The outline is the same thing written down: a line under another reads with its word in front. Click any word to change it.'],
  'guide-k': ['The working conclusion', 'The green card is your <b>conclusion</b>: the answer the argument arrives at. It also appears at the top of the page. It is your inference from the sources, not an official decision.'],
  'guide-q': ['Be honest about gaps', 'Dashed cards are <b>open questions</b>: what the sources don\'t settle. They double as your checklist for the call to the agency.<br><br>That was the <b>walkthrough</b>: the reading order you choose in Author mode (<b>Order steps</b>). Next, end the walkthrough, switch to <b>Author</b>, and move or edit anything. Your own boards start from <b>＋ New board</b>, or from passages you capture while browsing (<b>Evidence inbox</b>).'],
};

function tourBoard() {
  // Laid out automatically, in the shape of the outline.
  const node = (id, type, x, y, text, extra = {}) => ({ id, type, x, y, text, auto: true, ...extra });
  const evidence = (id, x, y, text, url, quote, note) => node(id, 'evidence', x, y, text,
    { url, quote, note, tier: 'Primary', checked: '2026-09-23', highlights: [], pdf: url.includes('/cdscontent/load?') });
  const link = (from, to, kind, label = '') => ({ id: crypto.randomUUID(), from, to, kind, label });
  return {
    version: 1, title: TOUR_TITLE, sample: false,
    subtitle: 'A worked example: self-employed Austrian citizen, no previous coverage. Sources checked Sept 2026. Not advice.',
    nodes: [
      node('guide-f1', 'fact', 30, 125, 'Self-employed without a trade licence (freelance)', { note: 'Case assumption.' }),
      node('guide-f2', 'fact', 30, 285, 'Expected annual profit at or below €6,613.20', { note: 'Case assumption. The 2026 SVS insurance threshold is €6,613.20.' }),
      node('guide-old', 'claim', 30, 500, 'ÖGK voluntary insurance is my only option.', { note: 'The assumption I started with.' }),
      node('guide-c1', 'claim', 420, 125, 'Below the threshold, SVS “Opting in” may provide health cover.', { note: 'Applies to eligible Neue Selbständige. Confirm eligibility and start date with SVS.' }),
      evidence('guide-e1', 420, 385, 'Income below the insurance threshold', SVS + '10007.816855',
        'können Sie sich für das „Opting in“ in der Krankenversicherung entscheiden.',
        '“…you can choose to opt in to health insurance.”'),
      node('guide-c2', 'claim', 860, 125, 'ÖGK voluntary insurance is another route, but may start with a waiting period.', { note: 'The ÖGK leaflet gives €565.25/month for 2026, possibly reduced based on means.' }),
      evidence('guide-e2', 860, 385, 'ÖGK voluntary health insurance', 'https://www.gesundheitskasse.at/cdscontent/load?contentid=10008.768502&version=1705493999',
        'Fehlen Ihnen diese Vorversicherungszeiten, können Sie erst nach einer Wartezeit von sechs Monaten Leistungen beziehen.',
        '“If you lack these prior insurance periods, you can only receive benefits after a six-month waiting period.”'),
      node('guide-k', 'conclusion', 1300, 125, 'Ask SVS about Opting in before treating ÖGK as the only option.', { note: 'Working inference from the linked guidance, not an individual determination.' }),
      node('guide-q', 'gap', 1300, 385, 'Which option applies to me, and on what date would benefits begin?', { note: 'Ask SVS and ÖGK. Record their answers and sources here.' }),
    ],
    links: [
      link('guide-f1', 'guide-c1', 'reasoning', 'no licence'),
      link('guide-f2', 'guide-c1', 'reasoning', 'below threshold'),
      link('guide-e1', 'guide-c1', 'supports'),
      link('guide-e1', 'guide-old', 'challenges', 'another route exists'),
      link('guide-c1', 'guide-c2', 'reasoning', 'compare with'),
      link('guide-e2', 'guide-c2', 'supports'),
      link('guide-c2', 'guide-k', 'reasoning', 'working inference'),
      link('guide-q', 'guide-k', 'questions', 'still open'),
    ],
    steps: ['guide-f1', 'guide-f2', 'guide-c1', 'guide-old', 'guide-c2', 'guide-k', 'guide-q'],
  };
}

const PRIMER = `
<div class="dialog-heading"><h2>How an evidence board works</h2><button data-close aria-label="Close">✕</button></div>
<p class="primer-lede">A board answers one question. Each step of the answer is pinned to the exact words of a source, so anyone can follow it back and check it.</p>
<div class="primer-grid">
  <div><span class="swatch fact"></span><b>Fact</b><p>Something true about your situation. The starting point.</p></div>
  <div><span class="swatch claim"></span><b>Claim</b><p>What a rule or source says, in your words.</p></div>
  <div><span class="swatch evidence"></span><b>Evidence</b><p>The exact passage, with a link that opens the page highlighted at it. Optionally a cropped screenshot.</p></div>
  <div><span class="swatch conclusion"></span><b>Conclusion</b><p>The answer your argument arrives at.</p></div>
  <div><span class="swatch gap"></span><b>Open question</b><p>What the sources don't settle yet.</p></div>
</div>
<p class="eyebrow">CONNECTIONS</p>
<ul class="primer-lines">
  <li><i class="line dotted"></i><span><b>Supports</b>: this evidence backs that card.</span></li>
  <li><i class="line red"></i><span><b>Objects to</b>: this says that card is wrong. It stays visible instead of being deleted.</span></li>
  <li><i class="line"></i><span><b>Leads to</b>: your reasoning from one card to the next.</span></li>
</ul>
<p class="eyebrow">HOW TO USE IT</p>
<ol class="primer-steps">
  <li><b>Jot:</b> in the <b>Outline</b> tab (or the side panel while reading), write thoughts one per line, unsorted. Press <b>Tab</b> to put a line under the one above it as a reason for it. Start a line with <b>?</b> for a question, <b>&gt;</b> for a quote, <b>!</b> for a conclusion, <b>-</b> for a fact about you. The spatial board arranges itself to match.</li>
  <li><b>Collect:</b> while browsing, select text → right-click → <i>Save passage as evidence</i>. It lands in the <b>Evidence inbox</b>.</li>
  <li><b>Author:</b> switch to <b>Author</b>, place evidence, write claims, connect cards, and set the <b>Order steps</b>.</li>
  <li><b>Present:</b> <b>▶ Walk through</b> steps through the argument one step at a time, and <b>Export brief</b> saves it as a standalone page to share.</li>
</ol>
<div class="dialog-actions"><button data-close>Close</button><button class="dark" data-guide="tour">▶ Take the guided tour</button></div>`;

export function init(api) {
  const $ = s => document.querySelector(s);

  async function openTour() {
    await api.flush();
    const { session, workspace } = api;
    let record = session.boards.find(b => b.content?.title === TOUR_TITLE);
    if (!record) record = await workspace.createBoard(session.journey.id, api.validateBoard(tourBoard()));
    location.href = '?' + new URLSearchParams({ j: session.journey.id, b: record.id, walk: '1' });
  }

  function openPrimer() {
    let dialog = $('#primer-dialog');
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'primer-dialog'; document.body.append(dialog); }
    dialog.innerHTML = PRIMER;
    dialog.showModal();
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-guide]');
    if (el) {
      e.preventDefault();
      $('#primer-dialog')?.open && $('#primer-dialog').close();
      if (el.dataset.guide === 'tour') openTour().catch(err => api.notify(err.message));
      else if (el.dataset.guide === 'primer') openPrimer();
      else if (el.dataset.guide === 'author') api.setAuthor(true);
      return;
    }
    if (e.target.closest('#primer-dialog [data-close]')) $('#primer-dialog').close();
  });

  $('#inbox-button')?.insertAdjacentHTML('beforebegin', '<button data-guide="primer" title="What the cards and lines mean">? How this works</button>');

  // Inject the tip for the current walkthrough step. renderWalk() replaces the
  // walkthrough's contents on every step, so re-apply after each change.
  const walk = $('#walkthrough');
  const applyTip = () => {
    const tip = TIPS[api.currentStep()];
    if (!tip || walk.querySelector('.tour-tip')) return;
    const box = document.createElement('details');
    box.className = 'tour-tip';
    box.innerHTML = `<summary>Tutorial · ${tip[0]}</summary><p>${tip[1]}</p>`;
    walk.querySelector('.walk-controls')?.before(box);
  };
  new MutationObserver(applyTip).observe(walk, { childList: true });
  applyTip();
}
