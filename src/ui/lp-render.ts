/*
 * inspired and adapted from https://github.com/artisticat1/obsidian-latex-suite/blob/main/src/conceal.ts
 *
 * The original work is MIT-licensed.
 *
 * MIT License
 *
 * Copyright (c) 2022 artisticat1
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * */

import { Decoration, DecorationSet, EditorView, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { EditorSelection, Line, Range } from "@codemirror/state";
import { syntaxTree, tokenClassNodeProp } from "@codemirror/language";
import { DataviewSettings } from "../settings";
import { FullIndex } from "../data-index";
import { App, Component, editorInfoField, editorLivePreviewField, TFile } from "obsidian";
import { DataviewApi } from "../api/plugin-api";
import { tryOrPropogate } from "../util/normalize";
import { parseField } from "../expression/parse";
import { executeInline } from "../query/engine";
import { Literal } from '../data-model/value';
import { DataviewInlineApi } from "../api/inline-api";
import { renderValue } from "./render";
import { SyntaxNode } from "@lezer/common";
import { InlineField, extractInlineFields } from "data-import/inline-field";

function selectionAndRangeOverlap(selection: EditorSelection, rangeFrom: number, rangeTo: number) {
    for (const range of selection.ranges) {
        if (range.from <= rangeTo && range.to >= rangeFrom) {
            return true;
        }
    }

    return false;
}

class InlineWidget extends WidgetType {
    constructor(
        readonly cssClasses: string[],
        readonly sourceString: string,
        private el: HTMLElement,
        private view: EditorView,
    ) {
        super();
    }

    // Widgets only get updated when the source changes/the element gets focus and loses it
    // to prevent redraws when the editor updates.
    eq(other: InlineWidget): boolean {
        if (other.sourceString === this.sourceString) {
            // change CSS classes without redrawing the element
            for (let value of other.cssClasses) {
                if (!this.cssClasses.includes(value)) {
                    this.el.removeClass(value);
                } else {
                    this.el.addClass(value);
                }
            }
            return true;
        }
        return false;
    }

    // Add CSS classes and return HTML element.
    // In "complex" cases it will get filled with the correct text/child elements later.
    toDOM(view: EditorView): HTMLElement {
        this.el.addClasses(this.cssClasses);
        return this.el;
    }

    /* Make queries only editable when shift is pressed (or navigated inside with the keyboard
     * or the mouse is placed at the end, but that is always possible regardless of this method).
     * Mostly useful for links, and makes results selectable.
     * If the widgets should always be expandable, make this always return false.
     */
    ignoreEvent(event: MouseEvent | Event): boolean {
        // instanceof check does not work in pop-out windows, so check it like this
        if (event.type === "mousedown") {
            const currentPos = this.view.posAtCoords({ x: (event as MouseEvent).x, y: (event as MouseEvent).y });
            if ((event as MouseEvent).shiftKey) {
                // Set the cursor after the element so that it doesn't select starting from the last cursor position.
                if (currentPos) {
                    const { editor } = this.view.state.field(editorInfoField);
                    if (editor) {
                        editor.setCursor(editor.offsetToPos(currentPos));
                    }
                }
                return false;
            }
        }
        return true;
    }
}

function getCssClasses(props: Set<string>): string[] {
    const classes: string[] = [];
    if (props.has("strong")) {
        classes.push("cm-strong");
    }
    if (props.has("em")) {
        classes.push("cm-em");
    }
    if (props.has("highlight")) {
        classes.push("cm-highlight");
    }
    if (props.has("strikethrough")) {
        classes.push("cm-strikethrough");
    }
    if (props.has("comment")) {
        classes.push("cm-comment");
    }
    return classes;
}

export function inlinePlugin(app: App, index: FullIndex, settings: DataviewSettings, api: DataviewApi) {
    return ViewPlugin.fromClass(
        class implements PluginValue {
            decorations: DecorationSet;
            component: Component;

            constructor(view: EditorView) {
                this.component = new Component();
                this.component.load();
                this.decorations = this.inlineRender(view) ?? Decoration.none;
            }

            update(update: ViewUpdate) {
                // only activate in LP and not source mode
                if (!update.state.field(editorLivePreviewField)) {
                    this.decorations = Decoration.none;
                    return;
                }
                if (update.docChanged) {
                    this.decorations = this.decorations.map(update.changes);
                    this.updateTree(update.view);
                    return;
                }
                if (update.selectionSet) {
                    this.updateTree(update.view);
                    return;
                }
                if (update.viewportChanged /*&& update.selectionSet*/) {
                    this.decorations = this.inlineRender(update.view) ?? Decoration.none;
                    return;
                }
            }

            updateInlineFields(view: EditorView) {

            }

            updateTree(view: EditorView) {
                for (const { from, to } of view.visibleRanges) {
                    // Inline fields
                    const lineFrom = view.state.doc.lineAt(from).number;
                    const lineTo = view.state.doc.lineAt(to).number;

                    for (let i = lineFrom; i <= lineTo; i++) {
                        const line = view.state.doc.line(i);

                        for (const field of extractInlineFields(line.text)) {
                            const { render } = this.fieldRenderInfo(view, line, field);
                            if (render) {
                                this.addFieldDecorator(view, line, field);
                            } else {
                                this.removeFieldDecorator(line, field);
                            }
                        }
                    }

                    // Inline queries
                    syntaxTree(view.state).iterate({
                        from,
                        to,
                        enter: ({ node }) => {
                            const { render, isQuery } = this.queryRenderInfo(view, node);
                            if (!render && isQuery) {
                                this.removeQueryDecorator(node);
                            } else if (render) {
                                this.addQueryDecorator(node, view);
                            }
                        },
                    });
                }
            }

            /**
             * Removes a field decorator from the screen, revealing the underlying text.
             * @param line The line the field is found on
             * @param field The field
             */
            removeFieldDecorator(line: Line, field: InlineField) {
                this.decorations.between(line.from+field.start, line.from+field.end, (from, to, _value) => {
                    this.decorations = this.decorations.update({
                        filterFrom: from,
                        filterTo: to,
                        filter: (_from, _to, _value) => false,
                    });
                });
            }

            /**
             * Removes a decorator from an inline query, revealing the underlying text.
             * @param node The codeblock node of the query
             */
            removeQueryDecorator(node: SyntaxNode) {
                this.decorations.between(node.from - 1, node.to + 1, (from, to, _value) => {
                    this.decorations = this.decorations.update({
                        filterFrom: from,
                        filterTo: to,
                        filter: (_from, _to, _value) => false,
                    });
                });
            }

            /**
             * Adds a field decorator back to the screen.
             * @param view The EditorView
             * @param line The line the field is found on
             * @param field The field
             */
            addFieldDecorator(view: EditorView, line: Line, field: InlineField) {
                let exists = false;
                this.decorations.between(line.from+field.start, line.from+field.end, (_from, _to, _value) => {
                    exists = true;
                });
                if (!exists) {
                    const currentFile = app.workspace.getActiveFile();
                    if (!currentFile) return;
                    const newDeco = this.createFieldWidget(view, line, field)?.value;
                    if (newDeco) {
                        this.decorations = this.decorations.update({
                            add: [{ from: line.from+field.start, to: line.from+field.end, value: newDeco }],
                        });
                    }
                }
            }

            /**
            * Adds a query back to the screen
            * @param node The codeblock node of the query
            * @param view The EditorView
            */
           addQueryDecorator(node: SyntaxNode, view: EditorView) {
               let exists = false;
               this.decorations.between(node.from - 1, node.to + 1, (_from, _to, _value) => {
                   exists = true;
               });
               if (!exists) {
                   const currentFile = app.workspace.getActiveFile();
                   if (!currentFile) return;
                   const newDeco = this.createQueryWidget(node, view, currentFile)?.value;
                   if (newDeco) {
                       this.decorations = this.decorations.update({
                           add: [{ from: node.from - 1, to: node.to + 1, value: newDeco }],
                       });
                   }
               }
           }

            /**
             * Get render information
             * @param view The EditorView
             * @param line The line the field is found on
             * @param field The field to check
             * @returns Rendering information about the field
             */
            fieldRenderInfo(view: EditorView, line: Line, field: InlineField): { render: any; } {
                const isSelected = selectionAndRangeOverlap(view.state.selection, line.from+field.start, line.from+field.end);
                return { render: !isSelected };
            }

            // checks whether a node should get rendered/unrendered
            queryRenderInfo(view: EditorView, node: SyntaxNode) {
                const properties = new Set(node.type.prop<String>(tokenClassNodeProp)?.split(" "));
                const isSelected = selectionAndRangeOverlap(view.state.selection, node.from - 1, node.to + 1);

                const isInlineQuery =
                    properties.has("inline-code") // is inline code block
                    && !properties.has("formatting") // is NOT formatting, like a backtick
                    && this.isInlineQuery(view, node.from, node.to); // and is a query

                return {
                    // Render if not selected
                    render: isInlineQuery && !isSelected,
                    isQuery: isInlineQuery
                };
            }

            isInlineQuery(view: EditorView, start: number, end: number) {
                const content = view.state.doc.sliceString(start, end);
                return content.startsWith(settings.inlineQueryPrefix)
                    || content.startsWith(settings.inlineJsQueryPrefix);
            }

            inlineRender(view: EditorView) {
                // still doesn't work as expected for tables and callouts
                if (!index.initialized) return;
                const currentFile = app.workspace.getActiveFile();
                if (!currentFile) return;

                const widgets: Range<Decoration>[] = [];
                /* before:
                 *     em for italics
                 *     highlight for highlight
                 * after:
                 *     strong for bold
                 *     strikethrough for strikethrough
                 */

                for (const { from, to } of view.visibleRanges) {
                    // Inline fields
                    const lineFrom = view.state.doc.lineAt(from).number;
                    const lineTo = view.state.doc.lineAt(to).number;
                    for (let i = lineFrom; i <= lineTo; i++) {
                        const line = view.state.doc.line(i);
                        for (const field of extractInlineFields(line.text)) {
                            if (!this.fieldRenderInfo(view, line, field).render) return;
                            const widget = this.createFieldWidget(view, line, field);
                            widgets.push(widget);
                        }
                    }
                    // Inline queries: Need DOM to replace code block surrounding it
                    syntaxTree(view.state).iterate({
                        from,
                        to,
                        enter: ({ node }) => {
                            if (!this.queryRenderInfo(view, node).render) return;
                            const widget = this.createQueryWidget(node, view, currentFile);
                            if (widget) {
                                widgets.push(widget);
                            }
                        },
                    });
                }

                return Decoration.set(widgets, true);
            }

            /**
             * Creates a widget for an inline field and returns a decoration that replaces the text of the field with the widget.
             * @param view The EditorView
             * @param line The line which the field sits on
             * @param field The field to create a widget for
             */
            createFieldWidget(view: EditorView, line: Line, field: InlineField): Range<Decoration> {
                const el = createSpan({
                    cls: ["dataview", "dataview-inline-field", `dataview-inline-field-style-${settings.inlineFieldDisplayMode.toLowerCase()}`]
                });

                if (field.wrapping === "(") {
                    el.appendChild(createSpan({
                        cls: ["dataview", "inline-field-value", "inline-value-standalone"],
                        text: field.value
                    }))
                } else if (field.wrapping === "[") {
                    el.appendChild(createSpan({
                        cls: ["dataview", "inline-field-key"],
                        text: field.key
                    }))
                    el.appendChild(createSpan({
                        cls: ["dataview", "inline-field-value"],
                        text: field.value
                    }))
                }

                return Decoration.replace({
                    widget: new InlineWidget([], view.state.doc.sliceString(line.from+field.start, line.from+field.end), el, view),
                    inclusive: false,
                    block: false
                }).range(line.from+field.start, line.from+field.end);
            }

            createQueryWidget(node: SyntaxNode, view: EditorView, currentFile: TFile) {
                // safety net against unclosed inline code
                if (view.state.doc.sliceString(node.to, node.to + 1) === "\n") {
                    return;
                }
                const text = view.state.doc.sliceString(node.from, node.to);
                let code: string = "";
                let result: Literal = "";
                const PREAMBLE: string = "const dataview=this;const dv=this;";
                const el = createSpan({
                    cls: ["dataview", "dataview-inline"],
                });
                /* If the query result is predefined text (e.g. in the case of errors), set innerText to it.
                 * Otherwise, pass on an empty element and fill it in later.
                 * This is necessary because {@link InlineQueryWidget.toDOM} is synchronous but some rendering
                 * asynchronous.
                 */
                const isQuery = text.startsWith(settings.inlineQueryPrefix);
                const isJsQuery = text.startsWith(settings.inlineJsQueryPrefix);
                if (!isQuery && !isJsQuery) {
                    return;
                } else if (isQuery&&!settings.enableInlineDataview || isJsQuery&&!settings.enableInlineDataviewJs) {
                    result = "(disabled; enable in settings)";
                    el.innerText = result;
                } else if (isQuery) {
                    code = text.substring(settings.inlineQueryPrefix.length).trim();
                    const field = tryOrPropogate(() => parseField(code));
                    if (!field.successful) {
                        result = `Dataview (inline field '${code}'): ${field.error}`;
                        el.innerText = result;
                    } else {
                        const fieldValue = field.value;
                        const intermediateResult = tryOrPropogate(() =>
                            executeInline(fieldValue, currentFile.path, index, settings)
                        );
                        if (!intermediateResult.successful) {
                            result = `Dataview (for inline query '${fieldValue}'): ${intermediateResult.error}`;
                            el.innerText = result;
                        } else {
                            const { value } = intermediateResult;
                            result = value;
                            renderValue(result, el, currentFile.path, this.component, settings);
                        }
                    }
                } else if (isJsQuery) {
                    code = text.substring(settings.inlineJsQueryPrefix.length).trim();
                    try {
                        // for setting the correct context for dv/dataview
                        const myEl = createDiv();
                        const dvInlineApi = new DataviewInlineApi(api, this.component, myEl, currentFile.path);
                        if (code.includes("await")) {
                            (evalInContext("(async () => { " + PREAMBLE + code + " })()") as Promise<any>).then(
                                (result: any) => {
                                    renderValue(result, el, currentFile.path, this.component, settings);
                                }
                            );
                        } else {
                            result = evalInContext(PREAMBLE + code);
                            renderValue(result, el, currentFile.path, this.component, settings);
                        }

                        function evalInContext(script: string): any {
                            return function () {
                                return eval(script);
                            }.call(dvInlineApi);
                        }
                    } catch (e) {
                        result = `Dataview (for inline JS query '${code}'): ${e}`;
                        el.innerText = result;
                    }
                }

                const tokenProps = node.type.prop<String>(tokenClassNodeProp);
                const props = new Set(tokenProps?.split(" "));
                const classes = getCssClasses(props);

                return Decoration.replace({
                    widget: new InlineWidget(classes, code, el, view),
                    inclusive: false,
                    block: false,
                }).range(node.from - 1, node.to + 1);
            }

            destroy() {
                this.component.unload();
            }
        },
        { decorations: v => v.decorations }
    );
}
