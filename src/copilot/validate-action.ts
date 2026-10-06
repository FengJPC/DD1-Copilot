import type { GameState } from "../state/game-state.js";
import { isBlockingPanelContext } from '../state/blocking-panel.js';
import { activityCandidate, canOpenBuildingUpgrades, facilityUpgradeFailure, heroUpgradeFailure, townPriceFailure, treatmentConfirmationFailure } from './town-availability.js';
import { currentCombatant, inventoryTarget, resolveRequestedTarget, resolveSkill, roomPropHero } from "./identity.js";
import type {
  CopilotAction
} from "./types.js";
import { CURIO_ONLY_INVENTORY_ITEMS, actionableRoomProps, currentDecisionRoomId, currentPhysicalArea, currentPhysicalTile, secretExitRoutes, skillIsUsableByCurrentActor, skillNeedsNoTarget } from './workflow-support.js';

export function validateAction(action: CopilotAction,
  state: GameState): string | undefined {
  if (isBlockingPanelContext(state.currentContext) && action.kind !== 'dismiss_modal') {
    return 'Close the character sheet or trinket inventory before issuing another action.';
  }
  if (["use_inventory_item", "use_torch", "discard_inventory_item"].includes(action.kind) &&
    (state.loot?.active === true || state.currentContext === "itemuse" ||
      !["room", "traveling", "camp", "combat", "post_combat"].includes(state.phase))) {
    return "Resolve the current overlay/targeting before operating the raid inventory.";
  }
  switch (action.kind) {
    case "open_town_location": {
      if (state.phase !== "town") {
        return "A town location can only be opened from the town map.";
      }
      const location = state.townLocations.find(
        (candidate) => candidate.id === action.locationId,
      );
      if (location === undefined) {
        return `Unknown town location: ${action.locationId}.`;
      }
      if (!location.unlocked || !location.screen) {
        return `Town location ${action.locationId} is not currently selectable.`;
      }
      return undefined;
    }
    case "open_embark":
      return state.phase === "town"
        ? undefined
        : "Embark can only be opened from the town map.";
    case "select_embark_quest": {
      if (state.phase !== "embark") {
        return "A quest can only be selected from expedition planning.";
      }
      const quests = state.expedition?.quests.filter((candidate) =>
        action.questIndex !== undefined
          ? candidate.questIndex === action.questIndex
          : candidate.questId === action.questId) ?? [];
      if (quests.length !== 1) {
        return quests.length === 0
          ? `Unknown embark quest: ${action.questIndex ?? action.questId ?? "missing selector"}.`
          : `Embark quest ID ${action.questId} is ambiguous; use questIndex.`;
      }
      const quest = quests[0]!;
      return quest.onScreen
        ? undefined
        : `Embark quest ${quest.questIndex} is not currently selectable.`;
    }
    case "form_embark_party":
      if (state.phase !== "embark") {
        return "A party can only be formed from expedition planning.";
      }
      if ((state.expedition?.selectedQuestIndex ?? -1) < 0) {
        return "Select an embark quest before forming the party.";
      }
      if (
        action.frontToBack.length !== 4 ||
        new Set(action.frontToBack).size !== 4
      ) {
        return "frontToBack must contain four distinct roster hero GUIDs.";
      }
      for (const guid of action.frontToBack) {
        const heroes = state.partyPlanning?.rosterCandidates.filter((hero) => hero.heroGuid === guid) ?? [];
        if (heroes.length !== 1 || heroes[0]!.missing || ![0, 1].includes(heroes[0]!.state)) {
          return `Roster GUID ${guid} is missing, ambiguous, or unavailable. Refresh the preparation roster.`;
        }
      }
      return undefined;
    case "proceed_to_provision":
      if (state.phase !== "embark") {
        return "Provisioning can only be opened from expedition planning.";
      }
      return state.partyPlanning?.filledCount === 4
        ? undefined
        : "A full four-hero party is required before provisioning.";
    case "buy_provision": {
      if (state.phase !== "provision") {
        return "Supplies can only be bought from provisioning.";
      }
      const item = state.provisioning?.items.find(
        (candidate) =>
          candidate.section === 0 && candidate.itemKey === action.itemKey,
      );
      if (item === undefined || item.amount < 1) {
        return `Provision ${action.itemKey} is not currently available.`;
      }
      return Number.isInteger(action.quantity) &&
        action.quantity >= 1 &&
        action.quantity <= Math.min(32, item.amount)
        ? undefined
        : `Quantity for ${action.itemKey} must be between 1 and ${Math.min(32, item.amount)}.`;
    }
    case "start_expedition":
      return state.phase === "provision"
        ? undefined
        : "An expedition can only start from provisioning.";
    case "continue_loading":
      return state.phase === "loading"
        ? undefined
        : "No loading screen is waiting for input.";
    case "travel_to_room": {
      if (state.phase !== "room" || state.combatActive) {
        return "Travel can only start from a dungeon room outside combat.";
      }
      const map = state.dungeonMap;
      const currentRoomId = currentDecisionRoomId(state);
      if (map?.completedTick === undefined || currentRoomId === undefined) {
        return "A completed map snapshot is required before choosing a route.";
      }
      if (actionableRoomProps(state).length > 0) {
        return "Resolve the active room interactable before choosing a route.";
      }
      const destination = map.areas.find(
        (area) => area.areaId === action.roomId && area.areaKind === 0,
      );
      if (destination === undefined) {
        return `Room ${action.roomId} is not present in the current map snapshot.`;
      }
      const routeExists = currentRoomId.startsWith("sec")
        ? secretExitRoutes(state, currentRoomId).some(
          (route) => route.roomId === action.roomId,
        )
        : map.edges.some(
          (edge) =>
            edge.fromAreaId === currentRoomId && edge.toAreaId === action.roomId,
        );
      return routeExists
        ? undefined
        : `Room ${action.roomId} is not adjacent to ${currentRoomId}.`;
    }
    case "advance_corridor": {
      if (state.combatActive) {
        return "Corridor movement is unavailable during combat.";
      }
      const area = currentPhysicalArea(state);
      const tile = currentPhysicalTile(state);
      if (area?.areaKind !== 1 || tile === undefined) {
        return "A verified corridor position is required before advancing.";
      }
      if (actionableRoomProps(state).length > 0) {
        return "Resolve the active corridor interactable before advancing.";
      }
      return tile < area.tileCount - 1
        ? undefined
        : "The party is already at the forward door.";
    }
    case "enter_room": {
      if (state.combatActive) {
        return "A room cannot be entered during combat.";
      }
      const area = currentPhysicalArea(state);
      const tile = currentPhysicalTile(state);
      if (area?.areaKind !== 1 || tile === undefined) {
        return "A verified corridor position is required before entering a room.";
      }
      if (actionableRoomProps(state).length > 0) {
        return "Resolve the active corridor interactable before entering a room.";
      }
      const atSecretDoor = area.tiles.some(
        (candidate) => candidate.current && candidate.content === 13,
      );
      return tile >= area.tileCount - 1 || atSecretDoor
        ? undefined
        : "The party has not reached the forward door yet.";
    }
    case "return_to_previous_room": {
      if (state.combatActive) {
        return "A previous room cannot be entered during combat.";
      }
      const area = currentPhysicalArea(state);
      const tile = currentPhysicalTile(state);
      if (area?.areaKind !== 1 || tile !== 0) {
        return "Returning requires a verified corridor position at tile 0.";
      }
      if (actionableRoomProps(state).length > 0) {
        return "Resolve the active corridor interactable before returning.";
      }
      return undefined;
    }
    case "approach_room_prop": {
      if (state.combatActive) return "An interactable cannot be approached during combat.";
      const prop = state.room?.props?.find(
        (candidate) =>
          candidate.propIndex === action.propIndex &&
          candidate.active &&
          !state.ignoredPropKeys.includes(
            `${candidate.address}\u0000${candidate.name}`,
          ),
      );
      if (prop === undefined) return `Room prop ${action.propIndex} is not active.`;
      if (prop.reachable) return `Room prop ${action.propIndex} is already reachable.`;
      return prop.direction === -1 || prop.direction === 1
        ? undefined
        : `Room prop ${action.propIndex} has no safe approach direction.`;
    }
    case "interact_room_prop": {
      if (state.combatActive) return "An interactable cannot be used during combat.";
      const prop = state.room?.props?.find(
        (candidate) =>
          candidate.propIndex === action.propIndex &&
          candidate.active &&
          !state.ignoredPropKeys.includes(
            `${candidate.address}\u0000${candidate.name}`,
          ),
      );
      if (prop === undefined) return `Room prop ${action.propIndex} is not active.`;
      if (!prop.reachable) return `Room prop ${action.propIndex} is not yet reachable.`;
      const hero = roomPropHero(state, action);
      if (hero === undefined) {
        return action.heroIndex === undefined
          ? `Party hero GUID ${action.heroGuid} is unavailable or ambiguous.`
          : `Hero GUID ${action.heroGuid} and party index ${action.heroIndex} do not identify the same hero.`;
      }
      return undefined;
    }
    case "choose_event_option": {
      const event = state.eventOverlay;
      if (event?.active !== true) return "No event choice is currently active.";
      const option = event.options.find(
        (candidate) => candidate.optionIndex === action.optionIndex,
      );
      if (option === undefined) return `Event option ${action.optionIndex} is unavailable.`;
      if (!option.enabled) return `Event option ${action.optionIndex} is disabled.`;
      return option.itemSlot
        ? "Use use_item_on_event for an event item slot."
        : undefined;
    }
    case "use_item_on_event": {
      const event = state.eventOverlay;
      if (event?.active !== true) return "No event choice is currently active.";
      const option = event.options.find(
        (candidate) => candidate.optionIndex === action.optionIndex,
      );
      if (option === undefined || !option.enabled || !option.itemSlot) {
        return `Event option ${action.optionIndex} is not an enabled item slot.`;
      }
      if (!state.inventory.some((item) => item.slot === action.inventorySlot)) {
        return `Inventory slot ${action.inventorySlot} is empty.`;
      }
      return event.compatibleInventorySlots.includes(action.inventorySlot)
        ? undefined
        : `Inventory slot ${action.inventorySlot} is not compatible with this event.`;
    }
    case "take_all_loot":
    case "close_loot":
      return state.loot?.active === true
        ? undefined
        : "No loot window is currently active.";
    case "return_to_loot":
      return state.loot?.active === true && state.currentContext === "inventory"
        ? undefined
        : "An open loot window must be covered by the raid inventory.";
    case "take_loot_item": {
      if (state.loot?.active !== true) return "No loot window is currently active.";
      return state.loot.items.some((item) => item.itemIndex === action.itemIndex)
        ? undefined
        : `Loot item ${action.itemIndex} is unavailable.`;
    }
    case "replace_inventory_with_loot": {
      if (state.loot?.active !== true) return "No loot window is currently active.";
      if (!state.loot.items.some((item) => item.itemIndex === action.itemIndex)) {
        return `Loot item ${action.itemIndex} is unavailable.`;
      }
      return state.inventory.some((item) => item.slot === action.inventorySlot)
        ? undefined
        : `Inventory slot ${action.inventorySlot} is empty.`;
    }
    case "move_hero":
      if (!state.combatActive || state.phase !== "combat") {
        return "A hero can only move during a verified combat turn.";
      }
      if (!Number.isInteger(action.toSlot) || action.toSlot < 1 || action.toSlot > 4) {
        return "toSlot must be an integer from 1 through 4.";
      }
      return state.combatActions.some((candidate) => candidate.kind === "reorder")
        ? undefined
        : "Move is absent from the latest inspected action bar.";
    case "use_inventory_item": {
      const item = state.inventory.find((candidate) => candidate.slot === action.inventorySlot);
      if (item === undefined) return `Inventory slot ${action.inventorySlot} is empty.`;
      if (item.itemType === "trinket") return "Trinket equipment requires a dedicated verified equipment action.";
      if (CURIO_ONLY_INVENTORY_ITEMS.has(item.itemId)) {
        return `${item.name} can only be used through a verified event item option.`;
      }
      if (inventoryTarget(state, action) === undefined) {
        return "Item target is missing, ambiguous, lacks a runtime GUID, or conflicts with targetIndex. Refresh the party first.";
      }
      return state.loot?.active === true
        ? "Close or resolve the loot window before using the raid inventory."
        : undefined;
    }
    case "discard_inventory_item": {
      const item = state.inventory.find((candidate) => candidate.slot === action.inventorySlot);
      if (item === undefined) return `Inventory slot ${action.inventorySlot} is empty.`;
      return state.loot?.active === true
        ? "Close or resolve the loot window before using the raid inventory."
        : undefined;
    }
    case "use_torch":
      if (!state.inventory.some((item) => item.itemId === "torch" && item.amount > 0)) {
        return "No torch is present in the latest inventory snapshot.";
      }
      return inventoryTarget(state, {}) === undefined
        ? "No party member has a verified runtime GUID. Refresh the party before using a torch."
        : undefined;
    case "choose_camp_meal": {
      if (state.currentContext !== "meal") return "No camping meal choice is active.";
      const meal = state.camp?.meals.find((candidate) => candidate.optionIndex === action.optionIndex);
      if (meal === undefined) return `Camping meal option ${action.optionIndex} is unavailable.`;
      return meal.foodRequired >= 0 && meal.foodAvailable >= 0 && meal.foodRequired > meal.foodAvailable
        ? "The party does not have enough food for that meal."
        : undefined;
    }
    case "use_camp_skill":
      if (state.camp?.phase !== 6) return "Camping skills are only available during respite.";
      if ((action.targetHeroGuid !== undefined || action.targetIndex !== undefined) && inventoryTarget(state, action) === undefined) {
        return "Camping target identity is missing or conflicting.";
      }
      if (!Number.isInteger(action.skillSlot) || action.skillSlot < 1 || action.skillSlot > 4) {
        return "skillSlot must be an integer from 1 through 4.";
      }
      return state.combatActions.some(
        (candidate) => candidate.kind === "skill" && candidate.skillSlot === action.skillSlot,
      ) ? undefined : `Camping skill slot ${action.skillSlot} is unavailable.`;
    case "finish_camp":
      return state.camp?.phase === 6 && state.combatActions.some((candidate) => candidate.kind === "rest")
        ? undefined
        : "The finish-camp action is not available in the current respite state.";
    case "retreat_combat":
      return state.combatActive && state.quest?.button === "flee"
        ? undefined
        : "Combat retreat is not currently available.";
    case "abandon_expedition":
      return !state.combatActive && state.quest?.button === "abandon"
        ? undefined
        : "Expedition abandon is not currently available.";
    case "finish_quest":
      return state.quest?.button === "finish" || state.quest?.button === "regroup"
        ? undefined
        : "Quest completion is not currently available.";
    case "choose_quest_completion":
      return state.currentContext === "questdone"
        ? undefined
        : "No quest-complete choice is currently active.";
    case "continue_results":
      return state.currentContext === "results" && state.activeTutorial === undefined
        ? undefined
        : "No expedition results screen is currently active.";
    case "recruit_stage_coach_hero": {
      if (
        state.phase !== "building" ||
        state.currentBuilding !== "stage_coach"
      ) {
        return "A Stagecoach hero can only be recruited from the open Stagecoach screen.";
      }
      if (
        state.recruitment !== undefined &&
        state.recruitment.rosterCount >= state.recruitment.rosterCapacity
      ) {
        return "The hero roster is full.";
      }
      return state.buildingHeroes.some(
        (hero) => hero.heroAddress === action.heroAddress,
      )
        ? undefined
        : `Stagecoach hero ${action.heroAddress} is not currently available.`;
    }
    case "select_building_hero":
      return state.phase === "building" && state.buildingDetails?.heroes.some(
        (hero) => hero.heroGuid === action.heroGuid)
        ? undefined : `Building hero GUID ${action.heroGuid} is unavailable.`;
    case "buy_hero_upgrade": {
      if (state.phase !== "building") return "A building must be open to buy a hero upgrade.";
      if (state.buildingDetails?.selectedHeroGuid !== action.heroGuid)
        return `Select hero GUID ${action.heroGuid} before buying an upgrade.`;
      const option = state.buildingDetails.heroOptions.find((candidate) => candidate.optionId === action.optionId);
      const step = option?.stepDetails.find((candidate) => candidate.code === action.stepCode);
      if (!option || !step || step.purchased) return `Hero upgrade ${action.optionId}/${action.stepCode} is unavailable.`;
      return heroUpgradeFailure(state, option, step);
    }
    case "buy_town_item": {
      const item = state.buildingDetails?.shopItems.find((item) => item.itemId === action.itemId);
      return state.phase === 'building' && item
        ? townPriceFailure(state, item.priceKnown, item.price, item.currency)
        : `Town item ${action.itemId} is unavailable.`;
    }
    case 'prepare_town_treatment':
    case "assign_town_activity": {
      if (state.phase !== "building") return "A town activity building must be open.";
      const row = state.buildingDetails?.activities.find((candidate) =>
        candidate.activityId === action.activityId && candidate.slot === action.slot);
      if (!row || row.committedHeroGuid !== undefined || row.pendingHeroGuid !== undefined ||
        row.occupant >= 0 || row.locked || row.eventLocked)
        return `Town activity ${action.activityId} slot ${action.slot} is unavailable.`;
      if (row.treatment !== (action.kind === 'prepare_town_treatment'))
        return 'Use the treatment preparation action for a treatment slot, and assign for an ordinary activity.';
      const hero = activityCandidate(state, action.activityId, action.slot, action.heroGuid);
      return hero?.known && hero.eligible && hero.affordable
        ? undefined : hero?.reason || `Activity eligibility for hero GUID ${action.heroGuid} is unavailable or refused.`;
    }
    case "cancel_town_activity": {
      const row = state.buildingDetails?.activities.find((candidate) =>
        candidate.activityId === action.activityId && candidate.slot === action.slot);
      return state.phase === "building" && row !== undefined &&
        (row.committedHeroGuid !== undefined || row.pendingHeroGuid !== undefined)
        ? undefined : `Town activity ${action.activityId} slot ${action.slot} has no hero to cancel.`;
    }
    case 'choose_town_treatment': {
      const row = state.buildingDetails?.activities.find((row) => row.activityId === action.activityId && row.slot === action.slot);
      return state.phase === 'building' && row?.treatment && row.pendingHeroGuid === action.heroGuid &&
        state.buildingDetails?.treatments?.some((choice) => choice.activityId === action.activityId && choice.slot === action.slot &&
          choice.quirkId === action.quirkId && choice.mode === action.mode)
        ? undefined : 'This treatment choice is absent from the current pending hero.';
    }
    case 'confirm_town_treatment':
      return treatmentConfirmationFailure(state, action.activityId, action.slot, action.heroGuid);
    case "open_building_upgrades":
      return canOpenBuildingUpgrades(state)
        ? undefined : "The current building has no verified upgrade control.";
    case "buy_building_upgrade": {
      if (state.phase !== "building" || state.buildingDetails?.mode !== 1)
        return "Open the building upgrade screen before buying an upgrade.";
      const track = state.buildingDetails.upgrades.find((candidate) => candidate.trackId === action.trackId);
      return track !== undefined && action.stepCode === String.fromCharCode(97 + track.next)
        ? facilityUpgradeFailure(state, track) : `Building upgrade ${action.trackId}/${action.stepCode} is unavailable.`;
    }
    case 'return_to_town':
      return ['embark', 'provision'].includes(state.phase) ? undefined : 'Return to town is only available from expedition preparation.';
    case "close_building":
      return state.phase === "building"
        ? undefined
        : "No building screen is currently open.";
    case "assign_circus_contestant": {
      if (state.phase !== "circus" || state.circus?.complete !== true)
        return "The arena lineup snapshot is not ready.";
      const contestant = state.circus.contestants.find(
        (row) => row.heroAddress.toLowerCase() === action.heroAddress.toLowerCase(),
      );
      if (contestant === undefined || contestant.dlcLocked)
        return `Arena contestant ${action.heroAddress} is unavailable.`;
      return action.rank <= state.circus.slotCount
        ? undefined
        : `Arena rank ${action.rank} is unavailable.`;
    }
    case "activate_circus_hero": {
      if (state.circusCombat?.active !== true || state.circusCombat.complete !== true || !state.circusCombat.pickOpen)
        return "The arena hero-selection window is not open or its snapshot is incomplete.";
      return state.circusCombat.heroes.some(
        (hero) => hero.actorGuid === action.actorGuid && hero.canActivate,
      ) ? undefined : `Arena actor GUID ${action.actorGuid} cannot act now.`;
    }
    case "dismiss_modal":
      return state.phase === "modal" || state.currentContext === "tutorial" || state.activeTutorial !== undefined
        ? undefined
        : "No modal is currently active.";
    case 'choose_dialog_option':
      return state.phase === 'modal' && state.currentContext === 'dialog' &&
        state.activeDialog?.options.some((option) => option.optionIndex === action.optionIndex)
        ? undefined : 'The requested answer is absent from the current confirmation dialog.';
    case "cancel_targeting":
      return state.phase === "targeting" || state.currentContext === "itemuse"
        ? undefined
        : "No target selector is currently active.";
    case "pass_turn":
      if (state.circusCombat?.active === true && state.circusCombat.pickOpen) {
        return "Choose an arena hero before issuing an action-bar command.";
      }
      if (!state.combatActive || state.phase !== "combat") {
        return "A turn can only be passed during a verified combat turn.";
      }
      return state.combatActions.some((candidate) => candidate.kind === "pass")
        ? undefined
        : "Pass is absent from the latest inspected action bar.";
    case "use_skill": {
      if (state.circusCombat?.active === true && state.circusCombat.pickOpen) {
        return "Choose an arena hero before issuing a skill command.";
      }
      if (!state.combatActive || state.phase !== "combat") {
        return "A combat skill can only be used during a verified combat turn.";
      }
      const actor = currentCombatant(state);
      if (action.actorGuid !== undefined && actor?.actorGuid !== action.actorGuid) {
        return "The requested actor GUID is not the current combat performer.";
      }
      const skill = resolveSkill(state, action);
      if (skill === undefined) return "Skill ID/slot is missing, ambiguous, or inconsistent with the inspected action bar.";
      if (!skillIsUsableByCurrentActor(state, skill)) {
        return `Skill slot ${action.skillSlot} cannot be used from the active hero's current rank.`;
      }
      if (skillNeedsNoTarget(skill)) {
        return action.target === undefined
          ? undefined
          : "This skill reports no target; omit target and let the Copilot execute it directly.";
      }
      if (action.target === undefined) {
        return `Skill slot ${action.skillSlot} requires a target.`;
      }
      const requestedTarget = action.target;
      if (requestedTarget.targetGuid === undefined &&
        (requestedTarget.side === undefined || requestedTarget.slot === undefined)) {
        return "A combat target requires targetGuid or both side and slot.";
      }
      const target = resolveRequestedTarget(state, requestedTarget);
      if (target === undefined) {
        return requestedTarget.targetGuid === undefined
          ? `Target ${requestedTarget.side} slot ${requestedTarget.slot} is absent from the latest inspected room state.`
          : `Target GUID ${requestedTarget.targetGuid} is absent from the latest inspected room state.`;
      }
      return undefined;
    }
  }
}
