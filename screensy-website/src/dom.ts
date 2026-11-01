/**
 * Displays the popup with the given name. Does nothing if the popup does not
 * exist.
 *
 * @param name Name of the popup to display
 */
export const showPopup = (name: string): void => {
  document.getElementById(name)?.classList.remove("hidden");
};

/**
 * Hides the popup with the given name. Does nothing if the popup is not visible or if
 * the popup does not exist.
 *
 * @param name Name of the popup to hide
 */
export const hidePopup = (name: string): void => {
  document.getElementById(name)?.classList.add("hidden");
};

/**
 * Returns the element with the given ID, or throws if it is missing or has the wrong type. Every translation file
 * must contain the same elements.
 */
export const getElement = <T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T => {
  const element = document.getElementById(id);

  if (!(element instanceof type)) {
    throw new Error(`The element #${id} is missing.`);
  }

  return element;
};

/**
 * Fills every ".name-slot" inside the element with the given name.
 */
export const setNameSlots = (element: Element, name: string): void => {
  for (const slot of element.querySelectorAll(".name-slot")) {
    slot.textContent = name;
  }
};
