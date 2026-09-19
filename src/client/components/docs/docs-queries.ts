/**
 * Data layer for the Docs view. Everything lives under the ["docs"] query root, which App
 * invalidates when the server reports a `docs:changed` event (an agent wrote a page).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createDbEntry,
  deleteDbEntryPage,
  deleteDocPage,
  fetchDbEntries,
  fetchDbSchema,
  fetchDocPage,
  fetchDocsTree,
  resolveWikilinks,
  saveDocPage,
  searchDocs,
  updateDbEntryPage,
} from "../../api";
import { queryKeys } from "../../queryClient";

const SEARCH_LIMIT = 20;

export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function retryUnlessMissing(failureCount: number, error: unknown): boolean {
  return !isNotFoundError(error) && failureCount < 1;
}

export function useDocsTreeQuery() {
  return useQuery({ queryKey: queryKeys.docsTree, queryFn: fetchDocsTree });
}

export function useDocPageQuery(path: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.docsPage(path ?? ""),
    queryFn: () => fetchDocPage(path!),
    enabled: Boolean(path) && enabled,
    retry: retryUnlessMissing,
  });
}

export function useDbSchemaQuery(folder: string | null) {
  return useQuery({
    queryKey: queryKeys.docsSchema(folder ?? ""),
    queryFn: () => fetchDbSchema(folder!),
    enabled: Boolean(folder),
    retry: retryUnlessMissing,
  });
}

export function useDbCollectionQuery(folder: string | null) {
  return useQuery({
    queryKey: queryKeys.docsCollection(folder ?? ""),
    queryFn: async () => {
      const [schema, data] = await Promise.all([fetchDbSchema(folder!), fetchDbEntries(folder!)]);
      return { schema, entries: data.entries, total: data.total };
    },
    enabled: Boolean(folder),
    retry: retryUnlessMissing,
  });
}

export function useDocsSearchQuery(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: queryKeys.docsSearch(trimmed),
    queryFn: ({ signal }) => searchDocs(trimmed, SEARCH_LIMIT, 0, { prefix: true, signal }),
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

export function useWikilinksQuery(targets: readonly string[]) {
  return useQuery({
    queryKey: queryKeys.docsWikilinks(targets),
    queryFn: () => resolveWikilinks([...targets]),
    enabled: targets.length > 0,
    staleTime: 60_000,
  });
}

function useInvalidateDocs() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.docsRoot });
}

export function useSavePageMutation() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (input: { path: string; frontmatter: Record<string, unknown>; body: string; baseModified?: string }) =>
      saveDocPage(input.path, { frontmatter: input.frontmatter, body: input.body, baseModified: input.baseModified }),
    onSuccess: invalidate,
  });
}

export function useSaveEntryMutation() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (input: { path: string; fields: Record<string, unknown>; body: string; baseModified?: string }) =>
      updateDbEntryPage(input.path, { fields: input.fields, body: input.body, baseModified: input.baseModified }),
    onSuccess: invalidate,
  });
}

export function useCreateEntryMutation() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (input: { folder: string; fields: Record<string, unknown>; body?: string }) =>
      createDbEntry(input.folder, { fields: input.fields, body: input.body }),
    onSuccess: invalidate,
  });
}

export function useDeletePageMutation() {
  const invalidate = useInvalidateDocs();
  return useMutation({
    mutationFn: (input: { path: string; isEntry: boolean }) =>
      input.isEntry ? deleteDbEntryPage(input.path) : deleteDocPage(input.path),
    onSuccess: invalidate,
  });
}
