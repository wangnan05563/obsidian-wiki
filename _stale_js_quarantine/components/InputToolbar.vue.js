/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
const props = defineProps();
const emit = defineEmits();
function handleSelect(tool) {
    if (tool.disabled)
        return;
    emit('select', tool.key);
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['disabled']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['more-dropdown']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "input-toolbar" },
    ...{ class: ({ 'icon-only': props.iconOnly }) },
});
for (const [tool] of __VLS_getVForSourceType((props.tools))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.handleSelect(tool);
            } },
        key: (tool.key),
        type: "button",
        ...{ class: "tool-chip" },
        ...{ class: ({
                active: props.activeMode === tool.key,
                'icon-only': props.iconOnly,
                disabled: tool.disabled,
            }) },
        title: (props.iconOnly
            ? (tool.disabled ? tool.disabledReason || '暂未实现' : tool.label)
            : (tool.disabled ? tool.disabledReason || '暂未实现' : undefined)),
        disabled: (tool.disabled),
    });
    if (tool.key === 'fast') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M13 2L4 14h7l-2 8 9-12h-7l2-8z",
            stroke: "currentColor",
            'stroke-width': "1.8",
            'stroke-linejoin': "round",
        });
    }
    else if (tool.key === 'write') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M3 21l3-3 11-11 3 3-11 11-3 3z",
            stroke: "currentColor",
            'stroke-width': "1.8",
            'stroke-linejoin': "round",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M14 7l3 3",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
    }
    else if (tool.key === 'ppt') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
            x: "3",
            y: "4",
            width: "18",
            height: "13",
            rx: "1",
            stroke: "currentColor",
            'stroke-width': "1.8",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "3",
            y1: "9",
            x2: "21",
            y2: "9",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "9",
            y1: "20",
            x2: "15",
            y2: "20",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "12",
            y1: "17",
            x2: "12",
            y2: "20",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
    }
    else if (tool.key === 'image') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
            x: "3",
            y: "3",
            width: "18",
            height: "18",
            rx: "2",
            stroke: "currentColor",
            'stroke-width': "1.8",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "8.5",
            cy: "8.5",
            r: "1.8",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M3 16l5-5 4 4 4-4 5 5",
            stroke: "currentColor",
            'stroke-width': "1.5",
            'stroke-linejoin': "round",
        });
    }
    else if (tool.key === 'video') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.rect)({
            x: "3",
            y: "5",
            width: "18",
            height: "14",
            rx: "2",
            stroke: "currentColor",
            'stroke-width': "1.8",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M10 9l5 3-5 3V9z",
            fill: "currentColor",
            stroke: "currentColor",
            'stroke-width': "1.5",
            'stroke-linejoin': "round",
        });
    }
    else if (tool.key === 'translate') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M4 5h9l-1 4M8 3v2c0 4-3 7-6 8M5 9c2 2 5 3 8 3",
            stroke: "currentColor",
            'stroke-width': "1.5",
            'stroke-linecap': "round",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.path)({
            d: "M12 20l4-9 4 9M14 17h4",
            stroke: "currentColor",
            'stroke-width': "1.8",
            'stroke-linecap': "round",
            'stroke-linejoin': "round",
        });
    }
    else if (tool.key === 'more') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            ...{ class: ({ rotated: props.moreOpen }) },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "5",
            cy: "12",
            r: "1.8",
            fill: "currentColor",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "12",
            cy: "12",
            r: "1.8",
            fill: "currentColor",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "19",
            cy: "12",
            r: "1.8",
            fill: "currentColor",
        });
    }
    else if (tool.key === 'web') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "12",
            cy: "12",
            r: "9",
            stroke: "currentColor",
            'stroke-width': "1.8",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.ellipse)({
            cx: "12",
            cy: "12",
            rx: "4",
            ry: "9",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "3",
            y1: "12",
            x2: "21",
            y2: "12",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "18",
            cy: "6",
            r: "2",
            fill: "currentColor",
            opacity: "0.6",
        });
    }
    else if (tool.key === 'deep') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
            ...{ class: "tool-icon" },
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "6",
            cy: "6",
            r: "2",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "18",
            cy: "6",
            r: "2",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "12",
            cy: "14",
            r: "2.5",
            stroke: "currentColor",
            'stroke-width': "1.8",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "6",
            cy: "20",
            r: "2",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
            cx: "18",
            cy: "20",
            r: "2",
            stroke: "currentColor",
            'stroke-width': "1.5",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "7.5",
            y1: "7",
            x2: "10.5",
            y2: "12.5",
            stroke: "currentColor",
            'stroke-width': "1.2",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "16.5",
            y1: "7",
            x2: "13.5",
            y2: "12.5",
            stroke: "currentColor",
            'stroke-width': "1.2",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "10.5",
            y1: "15.5",
            x2: "7.5",
            y2: "19",
            stroke: "currentColor",
            'stroke-width': "1.2",
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
            x1: "13.5",
            y1: "15.5",
            x2: "16.5",
            y2: "19",
            stroke: "currentColor",
            'stroke-width': "1.2",
        });
    }
    if (!props.iconOnly) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "tool-label" },
        });
        (tool.label);
    }
}
if (props.moreOpen && props.secondaryTools && props.secondaryTools.length) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "more-dropdown" },
    });
    for (const [tool] of __VLS_getVForSourceType((props.secondaryTools))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(props.moreOpen && props.secondaryTools && props.secondaryTools.length))
                        return;
                    __VLS_ctx.emit('select', tool.key);
                } },
            key: (tool.key),
            type: "button",
            ...{ class: "tool-chip secondary" },
            ...{ class: ({ active: props.activeMode === tool.key }) },
            title: (tool.label),
        });
        if (tool.key === 'web') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
                ...{ class: "tool-icon" },
                width: "16",
                height: "16",
                viewBox: "0 0 24 24",
                fill: "none",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "12",
                cy: "12",
                r: "9",
                stroke: "currentColor",
                'stroke-width': "1.8",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.ellipse)({
                cx: "12",
                cy: "12",
                rx: "4",
                ry: "9",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
                x1: "3",
                y1: "12",
                x2: "21",
                y2: "12",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "18",
                cy: "6",
                r: "2",
                fill: "currentColor",
                opacity: "0.6",
            });
        }
        else if (tool.key === 'deep') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.svg, __VLS_intrinsicElements.svg)({
                ...{ class: "tool-icon" },
                width: "16",
                height: "16",
                viewBox: "0 0 24 24",
                fill: "none",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "6",
                cy: "6",
                r: "2",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "18",
                cy: "6",
                r: "2",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "12",
                cy: "14",
                r: "2.5",
                stroke: "currentColor",
                'stroke-width': "1.8",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "6",
                cy: "20",
                r: "2",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.circle)({
                cx: "18",
                cy: "20",
                r: "2",
                stroke: "currentColor",
                'stroke-width': "1.5",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
                x1: "7.5",
                y1: "7",
                x2: "10.5",
                y2: "12.5",
                stroke: "currentColor",
                'stroke-width': "1.2",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
                x1: "16.5",
                y1: "7",
                x2: "13.5",
                y2: "12.5",
                stroke: "currentColor",
                'stroke-width': "1.2",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
                x1: "10.5",
                y1: "15.5",
                x2: "7.5",
                y2: "19",
                stroke: "currentColor",
                'stroke-width': "1.2",
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.line)({
                x1: "13.5",
                y1: "15.5",
                x2: "16.5",
                y2: "19",
                stroke: "currentColor",
                'stroke-width': "1.2",
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "tool-label" },
        });
        (tool.label);
    }
}
/** @type {__VLS_StyleScopedClasses['input-toolbar']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-label']} */ ;
/** @type {__VLS_StyleScopedClasses['more-dropdown']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-chip']} */ ;
/** @type {__VLS_StyleScopedClasses['secondary']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['tool-label']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            emit: emit,
            handleSelect: handleSelect,
        };
    },
    __typeEmits: {},
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeEmits: {},
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
