import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';
import { isBlockingPanelContext } from '../blocking-panel.js';
import { clearSessionObservationState, raidSurfacePhase } from '../reducer-support.js';

export function reduceSession(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "context_changed":
      next.currentContext = event.context;
      if (['dialog', 'tutorial', 'townevent', 'pause'].includes(event.context) || isBlockingPanelContext(event.context)) {
        if (state.phase !== 'modal') next.modalSourcePhase = state.phase;
      } else next.modalSourcePhase = undefined;
      if (event.context !== state.currentContext || event.context !== 'dialog') next.activeDialog = undefined;
      // The log is append-only across game processes. Replaying it must not
      // carry a previous expedition's overlays or inventory through a title
      // screen / load boundary into the newly loaded save. `none`, however,
      // is also the game's short transition context when leaving embark or a
      // building. Clearing the discovered town roster there makes the next
      // town-map snapshot unusable because the DLL intentionally emits the
      // roster only once per game session.
      if (
        event.context === "title" ||
        event.context === "loading"
      ) {
        clearSessionObservationState(next);
      }
      if (event.context !== "tutorial") next.activeTutorial = undefined;
      if (next.combatEndCandidate && (event.context === "actions" || event.context === "target")) {
        next.phase = "post_combat";
      } else if (event.context === "actions") {
        next.phase = "combat";
        next.selectedSkill = undefined;
        next.currentTarget = undefined;
        next.targets = [];
      }
      else if (event.context === "target") next.phase = "targeting";
      else if (event.context === "event") next.phase = "event";
      else if (event.context === "loot") next.phase = "loot";
      else if (event.context === "meal" || event.context === "camptarget") next.phase = "camp";
      else if (event.context === "quest" || event.context === "questdone" || event.context === "raidfinish") next.phase = "quest";
      else if (event.context === "results") next.phase = "results";
      else if (event.context === "room") next.phase = "room";
      else if (event.context === "building") next.phase = "building";
      else if (event.context === "embark") next.phase = "embark";
      else if (event.context === "provision") next.phase = "provision";
      else if (event.context === "loading") next.phase = "loading";
      else if (event.context === "ring" || event.context === "ringlist") next.phase = "circus";
      else if (event.context === "title" || event.context === "none") next.phase = "unknown";
      else if (
        event.context === "tutorial" ||
        event.context === "dialog" ||
        event.context === "townevent"
      ) next.phase = "modal";
      else if (event.context === "pause" || isBlockingPanelContext(event.context)) next.phase = "modal";
      else if (event.context === "inventory" || event.context === "map" || event.context === "ingame") {
        next.phase = raidSurfacePhase(next) ?? next.phase;
      }
      else if (event.context === "town" || event.context === "townmap") next.phase = "town";
      break;
    case 'confirmation_dialog_observed':
      if (state.phase !== 'modal') next.modalSourcePhase = state.phase;
      next.activeDialog = { text: event.text, answerCount: event.answerCount, options: event.options };
      next.currentContext = 'dialog';
      next.phase = 'modal';
      break;
    case "tutorial_opened":
      if (state.phase !== 'modal') next.modalSourcePhase = state.phase;
      next.activeTutorial = {
        tutorialId: event.tutorialId,
        text: event.text,
      };
      next.phase = "modal";
      break;
    case "tutorial_closed":
      next.activeTutorial = undefined;
      next.currentContext = event.context;
      if (event.context === "results") next.phase = "results";
      else if (event.context === "townevent" || event.context === "dialog") next.phase = "modal";
      else if (event.context === "town" || event.context === "townmap" || event.context === "townlog") next.phase = "town";
      else if (event.context === "ring" || event.context === "ringlist") next.phase = "circus";
      else next.phase = raidSurfacePhase(next) ?? next.phase;
      break;
    case "agent_state_started":
      next.combatants = [];
      next.combatActions = [];
      next.inventory = [];
      next.inventoryInfo = undefined;
      // A complete inspection describes only overlays that exist now. Clear
      // cached transient windows first; event/loot begin records in the same
      // snapshot will recreate them when they are actually still open.
      next.eventOverlay = undefined;
      next.loot = undefined;
      next.camp = undefined;
      next.quest = undefined;
      next.results = undefined;
      if (state.room !== undefined) next.room = { ...state.room, props: [] };
      next.inspection = { startedTick: event.tick };
      break;
    case "agent_state_completed":
      next.inspection = {
        startedTick: state.inspection?.startedTick ?? event.tick,
        completedTick: event.tick,
        ...(state.currentActor === undefined
          ? {}
          : { actorAddress: state.currentActor.address }),
      };
      break;
    default: return false;
  }
  return true;
}
