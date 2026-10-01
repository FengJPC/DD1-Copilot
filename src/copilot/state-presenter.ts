import type { CopilotSession, CopilotState } from './session.js';

/** Only suppress repeated map topology; preserve all decision-bearing fields. */
export class SessionStatePresenter {
  private mapTopology?: string;

  constructor(private readonly session: CopilotSession) { }

  reset() {
    this.mapTopology = undefined;
    this.session.tactical.reset();
  }

  project(state: CopilotState, includeMap = false): Record<string, unknown> {
    // An explicit diagnostic full request must stay full.
    if (state.state !== undefined) return state;
    if (['town', 'building', 'embark', 'provision', 'loading'].includes(state.phase)) {
      this.mapTopology = undefined;
    }
    if (state.changes !== undefined) {
      // Do not silently discard changes while advancing the revision cursor.
      return state;
    }
    if ((state.phase === 'combat' || state.phase === 'targeting') && state.combat?.active !== false) {
      return this.session.projectCombat(state);
    }
    const map = state.map;
    if (map === undefined) return state;
    const topology = JSON.stringify({
      areas: map.areas.map(({ current: _current, visited: _visited, tiles, ...area }) => ({ ...area, tiles: tiles.map(({ current: _tileCurrent, visited: _tileVisited, ...tile }) => tile) })),
      edges: map.edges,
    });
    if (includeMap || topology !== this.mapTopology) {
      this.mapTopology = topology;
      return state;
    }
    return {
      ...state, map: {
        currentAreaId: map.currentAreaId,
        currentRoomId: map.currentRoomId,
        positionTick: map.positionTick,
        visitedAreaIds: map.areas.filter((area) => area.visited).map((area) => area.areaId),
      }
    };
  }
}
