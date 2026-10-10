"use client";

import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

/**
 * Mouse: drag after moving 6px (plain clicks still work).
 * Touch (iPad): press and hold ~0.2s to pick a card up, so a normal swipe still scrolls the board.
 */
export function useBoardSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
}
