// gpui-base, headless: the three builders and the input state, all inert.
// `render()` in the durable mod builds its whole tree without ever calling into the app, which
// is what lets the layout be read under plain node.
import { element } from "./durable-tree.mjs";

export const v_flex = () => element("v_flex");
export const h_flex = () => element("h_flex");

/** The form's text fields: `.value()`, `.on()`, nothing that draws. */
export class InputState {
	static new({ value = "" } = {}) {
		return new InputState(value);
	}
	constructor(value) {
		this.text = value;
	}
	value() {
		return this.text;
	}
	set(next) {
		this.text = next;
	}
	on() {
		return this;
	}
}

export class Input {}
