// gpui-kit, headless: `View` is a class to inherit from, `div()` is a recorded element.
// The real kit draws; the durable mod only ever builds a chain, so recording is the whole job.
import { element } from "./durable-tree.mjs";

export class View {}

export const div = () => element("div");
