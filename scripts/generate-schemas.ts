import { resolve } from 'path'
import { writeFileSync } from 'fs'
import * as TJS from 'typescript-json-schema'
import { JSONSchema7 } from 'json-schema'
import {
  ApiModel,
  ApiPackage,
  ApiParameterListMixin,
  ApiDocumentedItem,
  ApiReturnTypeMixin,
  ApiMethodSignature,
} from '@microsoft/api-extractor-model'

const apiExtractorConfig = require('../api-extractor-base.json')

const agentPlugins: Record<string, Array<string>> = {
  'daf-core': ['IResolveDid', 'IDataStore', 'IKeyManager'],
  'daf-w3c': ['IW3c'],
}

interface RestMethod {
  operationId: string
  description?: string
  parameters: string
  response: string
}

const openApi = {
  openapi: '3.0.0',
  components: {
    schemas: {},
  },
  paths: {},
}

const genericTypes = ['boolean', 'string', 'number']

function createSchema(generator: TJS.JsonSchemaGenerator, symbol: string) {
  if (genericTypes.includes(symbol)) {
    return { components: { schemas: {} } }
  }

  //hack
  const fixedSymbol = symbol === 'EcdsaSignature | string' ? 'EcdsaSignature' : symbol
  // TODO fix 'EcdsaSignature | string' in openApi responses

  const schema = generator.getSchemaForSymbol(fixedSymbol)

  const newSchema = {
    components: {
      schemas: schema.definitions,
    },
  }

  let schemaStr = JSON.stringify(newSchema, null, 2)

  schemaStr = schemaStr.replace(/#\/definitions\//gm, '#/components/schemas/')
  schemaStr = schemaStr.replace(/\"patternProperties\":{([^:]*):{[^}]*}}/gm, '"pattern": $1')
  return JSON.parse(schemaStr)
}

for (const packageName of Object.keys(agentPlugins)) {
  const program = TJS.getProgramFromFiles([resolve('packages/' + packageName + '/src/index.ts')])
  const generator = TJS.buildGenerator(program, { required: true, topRef: true })

  const apiModel: ApiModel = new ApiModel()
  const apiPackage = apiModel.loadPackage(
    (apiExtractorConfig.docModel.apiJsonFilePath as string).replace('<unscopedPackageName>', packageName),
  )
  const entry = apiPackage.entryPoints[0]

  for (const pluginInterfaceName of agentPlugins[packageName]) {
    const pluginInterface = entry.findMembersByName(pluginInterfaceName)[0]

    // Collecting method information
    const methods: RestMethod[] = []
    for (const member of pluginInterface.members) {
      const method: Partial<RestMethod> = {}
      method.operationId = member.displayName
      // console.log(member)
      method.parameters = (member as ApiParameterListMixin).parameters[0].parameterTypeExcerpt.text
      method.response = (member as ApiReturnTypeMixin).returnTypeExcerpt.text
        .replace('Promise<', '')
        .replace('>', '')

      method.description = (member as ApiMethodSignature).tsdocComment?.summarySection
        ?.getChildNodes()[0]
        //@ts-ignore
        ?.getChildNodes()[0]?.text

      openApi.components.schemas = {
        ...openApi.components.schemas,
        ...createSchema(generator, method.parameters).components.schemas,
        ...createSchema(generator, method.response).components.schemas,
      }
      methods.push(method as RestMethod)
    }

    for (const method of methods) {
      //@ts-ignore
      openApi.paths['/' + method.operationId] = {
        post: {
          description: method.description,
          operationId: method.operationId,
          parameters: [
            {
              //@ts-ignore
              $ref: '#/components/schemas/' + method.parameters,
            },
          ],
          responses: {
            200: {
              description: method.description,
              content: {
                'application/json': {
                  schema: genericTypes.includes(method.response)
                    ? // TODO: is this correct?
                      { type: method.response }
                    : {
                        $ref: '#/components/schemas/' + method.response,
                      },
                },
              },
            },
          },
        },
      }
    }
  }
}

console.dir(openApi, { depth: 10 })
