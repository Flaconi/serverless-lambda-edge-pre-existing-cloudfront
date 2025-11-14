import { CloudFormationClient, ListExportsCommand } from '@aws-sdk/client-cloudformation'
import {
  CloudFrontClient,
  EventType,
  GetDistributionCommand,
  LambdaFunctionAssociations,
  UpdateDistributionCommand
} from '@aws-sdk/client-cloudfront'
import { LambdaClient, ListVersionsByFunctionCommand } from '@aws-sdk/client-lambda'
import type Serverless from 'serverless'
import type { Hooks, Logging } from 'serverless/classes/Plugin'
import type ServerlessPlugin from 'serverless/classes/Plugin'
import type AwsProvider from 'serverless/plugins/aws/provider/awsProvider'
import { setTimeout } from 'node:timers/promises'

interface PreExistingCloudFrontEvent extends AwsProvider.Event {
  preExistingCloudFront?: {
    distributionId: string
    eventType: EventType
    pathPattern: string
    includeBody: boolean
    stage?: string
  }
}

export default class ServerlessLambdaEdgePreExistingCloudFront implements ServerlessPlugin {
  public hooks: Hooks
  private readonly log: Logging['log']
  private readonly lambdaClient: LambdaClient
  private readonly cloudformationClient: CloudFormationClient
  private readonly cloudfrontClient: CloudFrontClient
  private readonly serverless: Serverless

  constructor(serverless: Serverless, options: Serverless.Options, logging: Logging) {
    this.serverless = serverless
    this.log = logging.log
    this.lambdaClient = new LambdaClient({
      region: this.region
    })
    this.cloudfrontClient = new CloudFrontClient({
      region: this.region
    })

    this.cloudformationClient = new CloudFormationClient({
      region: this.region
    })
    this.hooks = {
      'after:aws:deploy:finalize:cleanup': this.setupLambdaEdgePreExistingCloudFront.bind(this)
    }

    this.serverless.configSchemaHandler.defineCustomProperties({
      type: 'object',
      properties: {
        lambdaEdgePreExistingCloudFront: {
          type: 'object',
          properties: {
            validStages: {
              type: 'array',
              items: { type: 'string' },
              uniqueItems: true
            }
          }
        }
      }
    })

    this.serverless.configSchemaHandler.defineFunctionEvent('aws', 'preExistingCloudFront', {
      type: 'object',
      properties: {
        distributionId: {
          anyOf: [{ type: 'string' }, { type: 'object' }]
        },
        eventType: { type: 'string' },
        pathPattern: { type: 'string' },
        includeBody: { type: 'boolean' },
        stage: { type: 'string' }
      },
      required: ['distributionId', 'eventType', 'pathPattern', 'includeBody']
    })
  }

  get stage() {
    return this.serverless.getProvider('aws').getStage()
  }

  get region() {
    return this.serverless.service.provider.region
  }

  public async setupLambdaEdgePreExistingCloudFront() {
    const functions = this.serverless.service.getAllFunctions()
    const functionNames = functions.filter((functionName) => {
      const functionObj = this.serverless.service.getFunction(functionName)
      return functionObj.events
    })

    for (const functionName of functionNames) {
      const functionObj = this.serverless.service.getFunction(functionName)
      const events: PreExistingCloudFrontEvent[] = functionObj.events.filter(
        (event: PreExistingCloudFrontEvent) =>
          event.preExistingCloudFront && this.checkAllowedDeployStage()
      )
      for (const event of events) {
        if (
          event.preExistingCloudFront.stage !== undefined &&
          event.preExistingCloudFront.stage != `${this.serverless.service.provider.stage}`
        ) {
          continue
        }

        const functionArn = await this.getlatestVersionLambdaArn(functionObj.name)
        const resolvedDistributionId = await (event.preExistingCloudFront.distributionId[
          'Fn::ImportValue'
        ]
          ? this.resolveCfImportValue(event.preExistingCloudFront.distributionId['Fn::ImportValue'])
          : event.preExistingCloudFront.distributionId)
        this.log.notice(
          `${functionArn} (Event: ${event.preExistingCloudFront.eventType}, pathPattern: ${event.preExistingCloudFront.pathPattern}) is associating to ${resolvedDistributionId} CloudFront Distribution. waiting for deployed status.`
        )

        await this.updateDistribution(
          event.preExistingCloudFront,
          resolvedDistributionId,
          functionArn
        )
      }
    }
  }

  private async updateDistribution(
    preExistingCloudFront: PreExistingCloudFrontEvent['preExistingCloudFront'],
    resolvedDistributionId: string,
    functionArn: string,
    retryCount = 5
  ) {
    const config = await this.cloudfrontClient.send(
      new GetDistributionCommand({ Id: resolvedDistributionId })
    )

    if (preExistingCloudFront.pathPattern === '*') {
      config.Distribution.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations =
        await this.associateFunction(
          config.Distribution.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations,
          preExistingCloudFront,
          functionArn
        )
    } else {
      config.Distribution.DistributionConfig.CacheBehaviors =
        await this.associateNonDefaultCacheBehaviors(
          config.Distribution.DistributionConfig.CacheBehaviors,
          preExistingCloudFront,
          functionArn
        )
    }

    await this.cloudfrontClient
      .send(
        new UpdateDistributionCommand({
          Id: resolvedDistributionId,
          IfMatch: config.ETag,
          DistributionConfig: config.Distribution.DistributionConfig
        })
      )
      .catch(async (error) => {
        if (error.name === 'PreconditionFailed' && retryCount > 0) {
          this.log.error(`received precondition failed error, retrying... (${retryCount}/5)`)
          retryCount -= 1

          await setTimeout(5000)
          return this.updateDistribution(
            preExistingCloudFront,
            resolvedDistributionId,
            functionArn,
            retryCount
          )
        }
        this.log.error(error)
        throw error
      })
  }

  private checkAllowedDeployStage() {
    if (this.serverless.service.custom?.lambdaEdgePreExistingCloudFront?.validStages) {
      return this.serverless.service.custom.lambdaEdgePreExistingCloudFront.validStages.includes(
        this.stage
      )
    }
    return true
  }

  private async associateNonDefaultCacheBehaviors(
    cacheBehaviors,
    preExistingCloudFront: PreExistingCloudFrontEvent['preExistingCloudFront'],
    functionArn
  ) {
    for (const cacheBehavior of cacheBehaviors.Items) {
      if (preExistingCloudFront.pathPattern === cacheBehavior.PathPattern) {
        cacheBehavior.LambdaFunctionAssociations = await this.associateFunction(
          cacheBehavior.LambdaFunctionAssociations,
          preExistingCloudFront,
          functionArn
        )
      }
    }
    return cacheBehaviors
  }

  private async associateFunction(
    lambdaFunctionAssociations: LambdaFunctionAssociations,
    preExistingCloudFront: PreExistingCloudFrontEvent['preExistingCloudFront'],
    functionArn: string
  ) {
    const originals = lambdaFunctionAssociations.Items.filter(
      (x) => x.EventType !== preExistingCloudFront.eventType
    )
    lambdaFunctionAssociations.Items = originals
    lambdaFunctionAssociations.Items.push({
      LambdaFunctionARN: functionArn,
      IncludeBody: preExistingCloudFront.includeBody,
      EventType: preExistingCloudFront.eventType
    })
    lambdaFunctionAssociations.Quantity = lambdaFunctionAssociations.Items.length
    return lambdaFunctionAssociations
  }

  private async getlatestVersionLambdaArn(functionName: string, marker?: string) {
    const versions = await this.lambdaClient.send(
      new ListVersionsByFunctionCommand({
        FunctionName: functionName,
        MaxItems: 50,
        Marker: marker
      })
    )

    if (versions.NextMarker) {
      return await this.getlatestVersionLambdaArn(functionName, versions.NextMarker)
    }

    return versions.Versions.at(-1).FunctionArn
  }

  private async resolveCfImportValue(name: string, nextToken?: string) {
    const result = await this.cloudformationClient.send(
      new ListExportsCommand({ NextToken: nextToken })
    )

    const targetExportMeta = result.Exports.find((exportMeta) => exportMeta.Name === name)
    if (targetExportMeta) return targetExportMeta.Value
    if (result.NextToken) {
      return this.resolveCfImportValue(name, result.NextToken)
    }

    throw new Error(
      `Could not resolve Fn::ImportValue with name ${name}. Are you sure this value is exported ?`
    )
  }
}
