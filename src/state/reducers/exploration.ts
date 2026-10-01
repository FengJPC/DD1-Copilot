import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';

export function reduceExploration(state: GameState, next: GameState, event: BlindestEvent): boolean {
  switch (event.kind) {
    case "room_view_observed":
      next.phase = "room";
      next.navigation = undefined;
      next.room = {
        partyCount: event.partyCount,
        enemyCount: event.enemyCount,
        propCount: event.propCount,
        doorCount: event.doorCount,
        wave: event.wave,
        wayOn: event.wayOn,
        observedTick: event.tick,
        ...(state.pendingRoomDoorDestinations.length === 0
          ? {}
          : { doorDestinations: state.pendingRoomDoorDestinations }),
        props: [],
      };
      break;
    case "room_doors_started":
      next.pendingRoomDoorDestinations = [];
      break;
    case "room_door_observed":
      next.pendingRoomDoorDestinations = [
        ...state.pendingRoomDoorDestinations.filter(
          (areaId) => areaId !== event.destinationAreaId,
        ),
        event.destinationAreaId,
      ];
      break;
    case "map_move_started":
      next.phase = "traveling";
      next.navigation = {
        fromArea: event.fromArea,
        toArea: event.toArea,
        viaArea: event.viaArea,
        doorTile: event.doorTile,
      };
      break;
    case "map_snapshot_started":
      next.dungeonMap = {
        areaCount: event.areaCount,
        currentAreaId: event.currentAreaId,
        areas: [],
        edges: [],
      };
      break;
    case "map_area_observed": {
      const map = state.dungeonMap ?? {
        areaCount: 0,
        currentAreaId: event.current ? event.areaId : "",
        areas: [],
        edges: [],
      };
      next.dungeonMap = {
        ...map,
        currentAreaId: event.current ? event.areaId : map.currentAreaId,
        areas: [
          ...map.areas.filter((area) => area.areaId !== event.areaId),
          {
            areaIndex: event.areaIndex,
            areaId: event.areaId,
            areaKind: event.areaKind,
            current: event.current,
            tileCount: event.tileCount,
            visited: event.visited,
            tiles: map.areas.find((area) => area.areaId === event.areaId)?.tiles ?? [],
          },
        ].sort((left, right) => left.areaIndex - right.areaIndex),
      };
      break;
    }
    case "map_tile_observed": {
      const map = state.dungeonMap;
      const area = map?.areas.find((candidate) => candidate.areaId === event.areaId);
      if (map !== undefined && area !== undefined) {
        next.dungeonMap = {
          ...map,
          areas: map.areas.map((candidate) =>
            candidate.areaId !== event.areaId
              ? candidate
              : {
                ...candidate,
                tiles: [
                  ...candidate.tiles.filter(
                    (tile) => tile.tileIndex !== event.tileIndex,
                  ),
                  {
                    tileIndex: event.tileIndex,
                    tileType: event.tileType,
                    content: event.content,
                    knowledge: event.knowledge,
                    visible: event.visible,
                    visited: event.visited,
                    current: event.current,
                  },
                ].sort((left, right) => left.tileIndex - right.tileIndex),
              },
          ),
        };
      }
      break;
    }
    case "map_edge_observed": {
      const map = state.dungeonMap;
      if (map !== undefined) {
        next.dungeonMap = {
          ...map,
          edges: [
            ...map.edges.filter(
              (edge) =>
                edge.fromAreaId !== event.fromAreaId ||
                edge.toAreaId !== event.toAreaId,
            ),
            {
              fromAreaId: event.fromAreaId,
              direction: event.direction,
              toAreaId: event.toAreaId,
              corridorAreaId: event.corridorAreaId,
              corridorTiles: event.corridorTiles,
            },
          ],
        };
      }
      break;
    }
    case "map_position_observed": {
      const map = state.dungeonMap ?? {
        areaCount: 0,
        currentAreaId: event.areaId,
        areas: [],
        edges: [],
      };
      next.dungeonMap = {
        ...map,
        currentAreaId: event.areaId,
        positionTick: event.tick,
        areas: map.areas.map((area) => {
          const isCurrent = area.areaId === event.areaId;
          if (!isCurrent) return { ...area, current: false };
          const tiles = area.tiles.map((tile) => ({
            ...tile,
            current: tile.tileIndex === event.tileIndex,
            visited: tile.visited || tile.tileIndex === event.tileIndex,
          }));
          return {
            ...area,
            current: true,
            visited:
              area.areaKind === 0 ||
              (tiles.length === area.tileCount && tiles.every((tile) => tile.visited)),
            tiles,
          };
        }),
      };
      break;
    }
    case "map_snapshot_completed":
      if (state.dungeonMap !== undefined) {
        next.dungeonMap = { ...state.dungeonMap, completedTick: event.tick };
      }
      break;
    case "room_prop_observed":
      next.room = {
        ...(state.room ?? {
          partyCount: state.combatants.filter((actor) => actor.side === "party").length,
          enemyCount: state.combatants.filter((actor) => actor.side === "enemy").length,
          propCount: event.propIndex + 1,
          doorCount: 0,
          wave: false,
          wayOn: false,
          observedTick: event.tick,
          props: [],
        }),
        props: [
          ...(state.room?.props ?? []).filter(
            (prop) => prop.propIndex !== event.propIndex,
          ),
          {
            propIndex: event.propIndex,
            address: event.address,
            active: event.active,
            trap: event.trap,
            reachable: event.reachable,
            direction: event.direction,
            distance: event.distance,
            name: event.name,
          },
        ].sort((left, right) => left.propIndex - right.propIndex),
      };
      break;
    case "trap_chance_observed":
      next.combatants = state.combatants.map((combatant) =>
        combatant.actorAddress === event.actorAddress
          ? { ...combatant, trapDisarmChance: event.chance }
          : combatant,
      );
      break;
    default: return false;
  }
  return true;
}
