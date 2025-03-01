import { createError } from '../errors.js'
import type {
  AnyOrama,
  FacetResult,
  FacetSorting,
  FacetsParams,
  NumberFacetDefinition,
  SearchableValue,
  StringFacetDefinition,
  TokenScore
} from '../types.js'
import { getNested } from '../utils.js'

type FacetValue = string | boolean | number

function sortingPredicateBuilder(order: FacetSorting = 'desc') {
  return order.toLowerCase() === 'asc'
    ? (a: [string, number], b: [string, number]) => a[1] - b[1]
    : (a: [string, number], b: [string, number]) => b[1] - a[1]
}

export async function getFacets<T extends AnyOrama>(
  orama: T,
  results: TokenScore[],
  facetsConfig: FacetsParams<T>
): Promise<FacetResult> {
  const facets: FacetResult = {}
  const allIDs = results.map(([id]) => id)
  const allDocs = await orama.documentsStore.getMultiple(orama.data.docs, allIDs)
  const facetKeys = Object.keys(facetsConfig!)

  const properties = await orama.index.getSearchablePropertiesWithTypes(orama.data.index)

  for (const facet of facetKeys) {
    let values

    // Hack to guarantee the same order of ranges as specified by the user
    // TODO: Revisit this once components land
    if (properties[facet] === 'number') {
      const { ranges } = facetsConfig[facet] as NumberFacetDefinition
      const rangesLength = ranges.length
      const tmp: [string, number][] = Array.from({ length: rangesLength })
      for (let i = 0; i < rangesLength; i++) {
        const range = ranges[i]
        tmp[i] = [`${range.from}-${range.to}`, 0]
      }
      values = Object.fromEntries(tmp)
    }

    facets[facet] = {
      count: 0,
      values: values ?? {}
    }
  }

  const allDocsLength = allDocs.length
  for (let i = 0; i < allDocsLength; i++) {
    const doc = allDocs[i]

    for (const facet of facetKeys) {
      const facetValue = facet.includes('.')
        ? (await getNested<string>(doc!, facet))!
        : (doc![facet] as SearchableValue)

      const propertyType = properties[facet]
      const facetValues = facets[facet].values
      switch (propertyType) {
        case 'number': {
          const ranges = (facetsConfig[facet] as NumberFacetDefinition).ranges
          calculateNumberFacet(ranges, facetValues, facetValue as number)
          break
        }
        case 'number[]': {
          const alreadyInsertedValues = new Set<string>()
          const ranges = (facetsConfig[facet] as NumberFacetDefinition).ranges
          for (const v of facetValue as Array<number>) {
            calculateNumberFacet(ranges, facetValues, v, alreadyInsertedValues)
          }
          break
        }
        case 'boolean':
        case 'enum':
        case 'string': {
          calculateBooleanStringOrEnumFacet(facetValues, facetValue as FacetValue, propertyType)
          break
        }
        case 'boolean[]':
        case 'enum[]':
        case 'string[]': {
          const alreadyInsertedValues = new Set<string>()
          const innerType = propertyType === 'boolean[]' ? 'boolean' : 'string'
          for (const v of facetValue as Array<FacetValue>) {
            calculateBooleanStringOrEnumFacet(facetValues, v, innerType, alreadyInsertedValues)
          }
          break
        }
        default:
          throw createError('FACET_NOT_SUPPORTED', propertyType)
      }
    }
  }

  // TODO: We are looping again with the same previous keys, should we creat a single loop instead?
  for (const facet of facetKeys) {
    // Count the number of values for each facet
    facets[facet].count = Object.keys(facets[facet].values).length
    // Sort only string-based facets
    if (properties[facet] === 'string') {
      const stringFacetDefinition = facetsConfig[facet] as StringFacetDefinition
      const sortingPredicate = sortingPredicateBuilder(stringFacetDefinition.sort)

      facets[facet].values = Object.fromEntries(
        Object.entries(facets[facet].values)
          .sort(sortingPredicate)
          .slice(stringFacetDefinition.offset ?? 0, stringFacetDefinition.limit ?? 10)
      )
    }
  }

  return facets
}

function calculateNumberFacet(
  ranges: NumberFacetDefinition['ranges'],
  values: Record<string, number>,
  facetValue: number,
  alreadyInsertedValues?: Set<string>
) {
  for (const range of ranges) {
    const value = `${range.from}-${range.to}`
    if (alreadyInsertedValues?.has(value)) {
      continue
    }

    if (facetValue >= range.from && facetValue <= range.to) {
      if (values[value] === undefined) {
        values[value] = 1
      } else {
        values[value]++

        alreadyInsertedValues?.add(value)
      }
    }
  }
}

function calculateBooleanStringOrEnumFacet(
  values: Record<string, number>,
  facetValue: FacetValue,
  propertyType: 'string' | 'boolean' | 'enum',
  alreadyInsertedValues?: Set<string>
) {
  // String or boolean based facets
  const value = facetValue?.toString() ?? (propertyType === 'boolean' ? 'false' : '')
  if (alreadyInsertedValues?.has(value)) {
    return
  }
  values[value] = (values[value] ?? 0) + 1
  alreadyInsertedValues?.add(value)
}
