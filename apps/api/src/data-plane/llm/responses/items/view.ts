import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

export interface ResponsesItemsView<TSourceItems> {
  visitAsResponsesItems(items: TSourceItems, visit: (item: ResponsesInputItem) => void): Promise<void>;
}

export const responsesItemsView: ResponsesItemsView<readonly ResponsesInputItem[]> = {
  visitAsResponsesItems: async (items, visit) => {
    for (const item of items) visit(item);
  },
};
