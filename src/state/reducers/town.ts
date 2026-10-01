import type { BlindestEvent } from '../../blindest/events.js';
import type { GameState } from '../game-state.js';
import { reduceTownDetails } from './town-details.js';

export function reduceTown(state: GameState, next: GameState, event: BlindestEvent): boolean {
  if (reduceTownDetails(state, next, event)) return true;
  switch (event.kind) {
    case "building_opened":
      next.currentBuilding = event.buildingId;
      next.buildingHeroes = [];
      next.buildingDetails = undefined;
      next.recruitment = undefined;
      next.focusedHero = undefined;
      next.phase = "building";
      break;
    case "building_snapshot_started":
      if (event.buildingId === 'stage_coach' && event.mode === 0) {
        next.buildingHeroes = [];
        next.recruitment = undefined;
      }
      next.buildingDetails = {
        buildingId: event.buildingId, mode: event.mode, complete: false,
        activities: [], shopItems: [], memorials: [], heroes: [], heroOptions: [], upgrades: [],
      };
      break;
    case "building_snapshot_completed":
      if (state.buildingDetails?.buildingId === event.buildingId) {
        next.buildingDetails = { ...state.buildingDetails, complete: true };
      }
      break;
    case "town_wallet_observed":
      next.townWallet = {
        gold: event.gold, bust: event.bust, portrait: event.portrait,
        deed: event.deed, crest: event.crest, shard: event.shard,
      };
      break;
    case "building_activity_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = {
        ...details,
        activities: [
          ...details.activities.filter((row) => row.row !== event.row),
          {
            row: event.row, activityId: event.activityId, activityOrder: event.activityOrder,
            slot: event.slot, slotCount: event.slotCount, elementId: event.elementId,
            committedHeroGuid: event.committedHeroGuid, pendingHeroGuid: event.pendingHeroGuid,
            pendingHeroName: event.pendingHeroName, occupant: event.occupant, locked: event.locked,
            eventLocked: event.eventLocked, costsMoney: event.costsMoney,
          },
        ].sort((left, right) => left.row - right.row),
      };
      break;
    }
    case "building_shop_item_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = {
        ...details,
        shopItems: [
          ...details.shopItems.filter((item) => item.row !== event.row),
          {
            row: event.row, slot: event.slot, itemId: event.itemId, name: event.name,
            priceKnown: event.priceKnown, price: event.price, elementId: event.elementId
          },
        ].sort((left, right) => left.row - right.row),
      };
      break;
    }
    case "building_shop_item_effects_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = {
        ...details, shopItems: details.shopItems.map((item) =>
          item.row === event.row ? { ...item, effects: event.effects } : item)
      };
      break;
    }
    case "building_shop_item_metadata_observed": {
      const details = state.buildingDetails;
      if (details) next.buildingDetails = {
        ...details, shopItems: details.shopItems.map((item) =>
          item.row === event.row ? { ...item, rarity: event.rarity, classRequirement: event.classRequirement } : item)
      };
      break;
    }
    case "building_memorial_count_observed":
      if (state.buildingDetails) next.buildingDetails = { ...state.buildingDetails, memorialCount: event.count };
      break;
    case "building_memorial_observed":
      if (state.buildingDetails) next.buildingDetails = {
        ...state.buildingDetails,
        memorials: [...state.buildingDetails.memorials.filter((row) => row.row !== event.row),
        { row: event.row, text: event.text }].sort((a, b) => a.row - b.row),
      };
      break;
    case "building_hero_table_observed":
      if (state.buildingDetails) next.buildingDetails = {
        ...state.buildingDetails, selectedHeroGuid: event.selectedHeroGuid, heroCount: event.heroCount,
      };
      break;
    case "building_roster_hero_observed":
      if (state.buildingDetails) next.buildingDetails = {
        ...state.buildingDetails,
        heroes: [...state.buildingDetails.heroes.filter((hero) => hero.heroGuid !== event.heroGuid),
        { row: event.row, heroGuid: event.heroGuid, name: event.name }].sort((a, b) => a.row - b.row),
      };
      break;
    case "building_hero_option_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.heroOptions.find((option) => option.optionId === event.optionId);
        next.buildingDetails = {
          ...details,
          heroOptions: [
            ...details.heroOptions.filter((option) => option.optionId !== event.optionId),
            {
              column: event.column, optionId: event.optionId, optionHash: event.optionHash,
              optionKind: event.optionKind, skillIndex: event.skillIndex, level: event.level,
              selected: event.selected, steps: event.steps, bought: event.bought, next: event.next,
              name: event.name, stepDetails: previous?.stepDetails ?? []
            },
          ].sort((a, b) => (a.column ?? 999) - (b.column ?? 999)),
        };
      }
      break;
    }
    case "building_hero_option_step_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.heroOptions.find((option) => option.optionId === event.optionId);
        const step = {
          code: event.code, purchased: event.purchased, armed: event.armed,
          cost: event.cost, currency: event.currency, resolveRequired: event.resolveRequired,
          elementId: event.elementId, live: event.live
        };
        const option = previous ?? { optionId: event.optionId, stepDetails: [] };
        const updated = { ...option, stepDetails: [...option.stepDetails.filter((candidate) => candidate.code !== event.code), step] };
        next.buildingDetails = {
          ...details,
          heroOptions: [...details.heroOptions.filter((candidate) => candidate.optionId !== event.optionId), updated]
        };
      }
      break;
    }
    case "building_upgrade_step_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.upgrades.find((upgrade) => upgrade.track === event.track);
        const upgrade = previous ?? {
          track: event.track, trackHash: "", trackId: "", knownDefinition: false,
          steps: 0, armed: -1, bought: 0, next: -1, name: "", stepDetails: [],
        };
        const stepDetails = [
          ...upgrade.stepDetails.filter((step) => step.code !== event.code),
          { code: event.code, armed: event.armed },
        ].sort((a, b) => a.code.localeCompare(b.code));
        next.buildingDetails = {
          ...details,
          upgrades: [...details.upgrades.filter((candidate) => candidate.track !== event.track), { ...upgrade, stepDetails }]
            .sort((a, b) => a.track - b.track),
        };
      }
      break;
    }
    case "building_upgrade_track_observed": {
      const details = state.buildingDetails;
      if (details) {
        const previous = details.upgrades.find((upgrade) => upgrade.track === event.track);
        const upgrade = {
          track: event.track, trackHash: event.trackHash, trackId: event.trackId,
          knownDefinition: event.knownDefinition, steps: event.steps, armed: event.armed,
          bought: event.bought, next: event.next, name: event.name,
          stepDetails: previous?.stepDetails ?? [],
        };
        next.buildingDetails = {
          ...details,
          upgrades: [...details.upgrades.filter((candidate) => candidate.track !== event.track), upgrade]
            .sort((a, b) => a.track - b.track),
        };
      }
      break;
    }
    case "town_location_observed":
      next.townLocations = [
        ...state.townLocations.filter((location) => location.id !== event.id),
        {
          row: event.row,
          id: event.id,
          elementId: event.elementId,
          unlocked: event.unlocked,
          screen: event.screen,
          district: event.district,
          offSave: event.offSave,
          isNew: event.isNew,
          name: event.name,
        },
      ].sort((left, right) => left.row - right.row);
      break;
    case "town_map_ready":
      next.phase = "town";
      next.townMap = {
        layer: event.layer,
        locationCount: event.locationCount,
        selectedRow: event.selectedRow,
      };
      break;
    case "building_hero_observed":
      next.buildingHeroes = [
        ...state.buildingHeroes.filter((hero) => hero.slot !== event.slot),
        {
          row: event.row,
          slot: event.slot,
          heroAddress: event.heroAddress,
          name: event.name,
          elementId: event.elementId,
        },
      ].sort((left, right) => left.row - right.row);
      break;
    case "recruit_pending":
      next.recruitment = {
        pending: {
          slot: event.slot,
          heroAddress: event.heroAddress,
          name: event.name,
        },
        rosterCount: event.rosterCount,
        rosterCapacity: event.rosterCapacity,
      };
      break;
    case "recruit_cancelled":
      if (state.recruitment !== undefined) {
        next.recruitment = {
          rosterCount: state.recruitment.rosterCount,
          rosterCapacity: state.recruitment.rosterCapacity,
        };
      }
      break;
    default: return false;
  }
  return true;
}
