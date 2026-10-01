import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reduceResults(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "quest_observed":
      next.quest = {
        rowCount: event.rowCount,
        goalCount: event.goalCount,
        button: event.button,
        complete: event.complete,
        rows: [],
      };
      break;
    case "quest_row_observed":
      if (state.quest !== undefined) {
        next.quest = {
          ...state.quest,
          rows: [
            ...state.quest.rows.filter((row) => row.row !== event.row),
            { row: event.row, kind: event.rowKind, text: event.text },
          ].sort((left, right) => left.row - right.row),
        };
      }
      break;
    case "results_observed":
      next.results = {
        state: event.state,
        rowCount: event.rowCount,
        heroCount: event.heroCount,
        rows: state.results?.state === event.state ? state.results.rows : [],
        heroes: state.results?.state === event.state ? state.results.heroes : [],
      };
      if (state.activeTutorial === undefined && state.currentContext !== "tutorial") {
        next.phase = "results";
      }
      break;
    case "results_row_observed":
      if (state.results !== undefined) {
        next.results = {
          ...state.results,
          rows: [
            ...state.results.rows.filter((row) => row.row !== event.row),
            { row: event.row, text: event.text },
          ].sort((left, right) => left.row - right.row),
        };
      }
      break;
    case "results_hero_observed":
      if (state.results !== undefined) {
        const previous = state.results.heroes.find((hero) => hero.heroIndex === event.heroIndex);
        next.results = {
          ...state.results,
          heroes: [
            ...state.results.heroes.filter((hero) => hero.heroIndex !== event.heroIndex),
            {
              heroIndex: event.heroIndex,
              rowCount: event.rowCount,
              rows: previous?.rows ?? [],
            },
          ].sort((left, right) => left.heroIndex - right.heroIndex),
        };
      }
      break;
    case "results_hero_row_observed":
      if (state.results !== undefined) {
        const previous = state.results.heroes.find((hero) => hero.heroIndex === event.heroIndex) ?? {
          heroIndex: event.heroIndex,
          rowCount: 0,
          rows: [],
        };
        const hero = {
          ...previous,
          rows: [
            ...previous.rows.filter((row) => row.row !== event.row),
            { row: event.row, text: event.text },
          ].sort((left, right) => left.row - right.row),
        };
        next.results = {
          ...state.results,
          heroes: [
            ...state.results.heroes.filter((candidate) => candidate.heroIndex !== event.heroIndex),
            hero,
          ].sort((left, right) => left.heroIndex - right.heroIndex),
        };
      }
      break;
    default: return false;
  }
  return true;
}
