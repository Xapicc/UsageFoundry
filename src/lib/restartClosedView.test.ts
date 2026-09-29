import { strict as assert } from "node:assert";
import { test } from "node:test";
import { restartClosedView } from "./restartClosedView";

/**
 * What the restart notice draws after a press, decided in `restartClosedView`
 * rather than in three early returns in `RestartClosed`.
 *
 * Those returns failed silently in both of the ways a press can end:
 *
 *  - only a successful pick-up clears `restart_closed`, so after a press that
 *    refused runs the count is still above zero — and the answer was drawn only
 *    at zero. The notice and its button came back unchanged, and the sentence
 *    naming each refused run and its reason was never on screen. Some refusals
 *    are permanent, so every further press was refused again with nothing said.
 *  - a failed press returned the error instead of the notice, which took the
 *    button away, and the button was the only thing that cleared the error.
 *
 * Both cases are the same count, 2, with the old code drawing the wrong one of
 * its three answers for it.
 *
 * And once the answer was on screen, the offer above it still said the runs it
 * had just refused "can resume where they left off", over a button that would
 * only ask again — for a permanent refusal, for ever.
 */

const workflowRefusal =
  "This run was stopped with all of workflow “nightly”, and stopping a workflow run is final. Start that workflow again rather than picking one of its runs back up.";
const cyclesRefusal =
  "This run has already used 20 work cycles. Raise the cycle limit above that to carry on.";

const first = "3f2a9c1e-0000-4000-8000-000000000001";
const second = "b71d04aa-0000-4000-8000-000000000002";
const third = "c04e7d19-0000-4000-8000-000000000003";

test("a press that refused runs names each one and its reason", () => {
  const view = restartClosedView([first, second], {
    ok: true,
    reopened: 1,
    refused: [
      { id: first, reason: workflowRefusal },
      { id: second, reason: cyclesRefusal },
    ],
  });

  assert.ok(view.report, "a press that refused runs must be answered on screen");
  assert.deepEqual(
    view.report.refused.map((r) => [r.name, r.reason]),
    [
      ["3f2a9c1e", workflowRefusal],
      ["b71d04aa", cyclesRefusal],
    ],
  );
  assert.match(view.report.summary, /1 run back in the queue\. 2 refused/);
  assert.notEqual(view.report.tone, "info");
  // Pressing again meets the same refusal, so the notice has to say what does
  // take a run out of the count.
  assert.match(view.report.followUp ?? "", /set aside/);
});

test("a press that refused every run says none went back", () => {
  const view = restartClosedView([first], {
    ok: true,
    reopened: 0,
    refused: [{ id: first, reason: workflowRefusal }],
  });

  assert.match(view.report?.summary ?? "", /None went back in the queue\. 1 run refused/);
  assert.equal(view.report?.refused.length, 1);
});

test("runs the last press just refused are not offered as able to resume", () => {
  const refused = [
    { id: first, reason: workflowRefusal },
    { id: second, reason: cyclesRefusal },
  ];

  // The list read after the press is exactly what it refused.
  assert.equal(
    restartClosedView([first, second], { ok: true, reopened: 1, refused }).offer,
    null,
    "no sentence saying they can resume, and no button that would only ask again",
  );
  // A run that joined the list since is not offered either: the press picks up
  // the whole list, so its button would ask the refused runs again too.
  assert.equal(
    restartClosedView([first, second, third], { ok: true, reopened: 1, refused }).offer,
    null,
  );
  // Refusals of runs that have since left the list say nothing about the rest.
  assert.equal(
    restartClosedView([third], { ok: true, reopened: 0, refused }).offer,
    1,
  );
});

test("a failed press shows the failure and still offers the button", () => {
  const message =
    "The request did not reach the server — Failed to fetch. It may or may not have been carried out, so check before trying again.";
  const view = restartClosedView([first, second], { ok: false, message });

  assert.equal(view.offer, 2, "a retry must not need a reload");
  assert.equal(view.report?.tone, "danger");
  assert.equal(view.report?.summary, message);
  assert.deepEqual(view.report?.refused, []);
});

test("a press that picked everything up leaves only its answer", () => {
  const view = restartClosedView([], { ok: true, reopened: 3, refused: [] });

  assert.equal(view.offer, null);
  assert.equal(view.report?.tone, "info");
  assert.equal(view.report?.summary, "3 runs back in the queue.");
  assert.equal(view.report?.followUp, null);
});

test("with no press, whatever is waiting is offered", () => {
  assert.deepEqual(restartClosedView([first, second], null), { offer: 2, report: null });
});

test("no press and nothing waiting draws nothing, whether or not the list was read", () => {
  assert.deepEqual(restartClosedView([], null), { offer: null, report: null });
  assert.deepEqual(restartClosedView(null, null), { offer: null, report: null });
});
