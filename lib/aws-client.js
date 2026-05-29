// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const SAVE_URL = process.env.AWS_SAVE_URL || 'https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs';
const CDN_BASE = 'https://d1qsjq9pzbk1k6.cloudfront.net';

const PARTITIONS = {
  'aws': {
    manifestPath: '/manifest/en_US.json',
    cdnPrefix: '',
    contract: null,
    awsPartition: 'aws',
    regions: {},
  },
  'aws-iso': {
    manifestPath: '/aws-iso/manifest/en_US.json',
    cdnPrefix: '/aws-iso',
    contract: '5423f8cd3b711c6f899ba4dade31b50c',
    awsPartition: 'aws-iso',
    regions: {
      'us-iso-east-1': 'US ISO East',
      'us-iso-west-1': 'US ISO West',
    },
  },
  'aws-iso-b': {
    manifestPath: '/aws-iso-b/manifest/en_US.json',
    cdnPrefix: '/aws-iso-b',
    contract: '5423f8cd3b711c6f899ba4dade31b50c',
    awsPartition: 'aws-iso-b',
    regions: {
      'us-isob-east-1': 'US ISOB East (Ohio)',
    },
  },
};

const MANIFEST_URL = process.env.AWS_MANIFEST_URL || `${CDN_BASE}${PARTITIONS['aws'].manifestPath}`;

function resolvePartition(region) {
  if (!region) return 'aws';
  if (region.startsWith('us-iso-')) return 'aws-iso';
  if (region.startsWith('us-isob-')) return 'aws-iso-b';
  return 'aws';
}

const manifestCache = new Map();
const definitionCache = new Map();
const metadataCache = new Map();

const METADATA_CDN = 'https://calculator.aws';

/**
 * Fetch PLC_2.0 metadata.json for a mapping definition.
 * Returns { valueAttributes, primarySelectors, secondarySelectors } or null on failure.
 */
async function fetchMappingMetadata(mappingDef) {
  if (!mappingDef || mappingDef.mappingDefinitionVersion !== 'PLC_2.0') return null;
  const url = mappingDef.mappingDefinitionURL;
  if (!url || !url.endsWith('metadata.json')) return null;

  const resolved = `${METADATA_CDN}/${url.replace('[currency]', 'USD')}`;
  if (metadataCache.has(resolved)) return metadataCache.get(resolved);

  const promise = (async () => {
    try {
      const res = await fetch(resolved);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        valueAttributes: data.valueAttributes || {},
        primarySelectors: data.primarySelectors || [],
        secondarySelectors: data.secondarySelectors || [],
      };
    } catch { return null; }
  })();

  metadataCache.set(resolved, promise);
  return promise;
}

async function loadManifest(partition = 'aws') {
  if (!PARTITIONS[partition]) {
    throw new Error(`Unknown partition '${partition}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}`);
  }

  if (manifestCache.has(partition)) return manifestCache.get(partition);

  const url = `${CDN_BASE}${PARTITIONS[partition].manifestPath}`;
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    const manifest = await res.json();
    const services = new Map();
    manifest.awsServices.forEach(s => {
      const key = s.key || s.serviceCode;
      if (key) services.set(key, { ...s, key });
    });
    console.error(`Loaded ${services.size} services from manifest (partition: ${partition})`);
    return services;
  })();

  manifestCache.set(partition, promise);

  // Allow retry on failure — clear only this partition's cache entry
  promise.catch(() => { manifestCache.delete(partition); });

  return promise;
}

/**
 * Alias map: common short/alternate names → actual manifest key.
 * This bridges the gap between what callers typically use (e.g. "amazonEC2")
 * and the actual manifest key (e.g. "ec2Enhancement").
 */
const SERVICE_KEY_ALIASES = {
  // EC2
  amazonec2: 'ec2Enhancement',
  ec2: 'ec2Enhancement',
  amazonec2next: 'eC2Next',

  // EKS
  amazoneks: 'awsEks',
  eks: 'awsEks',

  // EBS
  amazonebs: 'amazonElasticBlockStore',
  amazonelasticblockstore: 'amazonElasticBlockStore',
  ebs: 'amazonElasticBlockStore',

  // OpenSearch (was Elasticsearch)
  amazonopensearch: 'amazonElasticsearchService',
  amazonopensearchservice: 'amazonElasticsearchService',
  opensearch: 'amazonElasticsearchService',
  elasticsearch: 'amazonElasticsearchService',
  amazonelasticsearch: 'amazonElasticsearchService',

  // SQS
  amazonsqs: 'amazonSimpleQueueService',
  sqs: 'amazonSimpleQueueService',

  // SNS
  amazonsns: 'amazonSimpleNotificationService',
  sns: 'amazonSimpleNotificationService',

  // SES
  amazonses: 'amazonSimpleEmailService',
  ses: 'amazonSimpleEmailService',

  // GameLift
  amazongameliftservers: 'amazonGameLift',
  amazongamelift: 'amazonGameLift',
  gamelift: 'amazonGameLift',

  // RDS Oracle
  amazonrdsoracledb: 'amazonRdsForOracle',
  amazonrdsfororacle: 'amazonRdsForOracle',
  rdsoracle: 'amazonRdsForOracle',

  // RDS SQL Server
  amazonrdssqlserverdb: 'amazonRDSForSQLServer',
  amazonrdsforsqlserver: 'amazonRDSForSQLServer',
  rdssqlserver: 'amazonRDSForSQLServer',

  // Aurora MySQL
  amazonauroramysqldb: 'amazonAuroraMySQLCompatible',
  amazonauroramysql: 'amazonAuroraMySQLCompatible',
  auroramysql: 'amazonAuroraMySQLCompatible',

  // Aurora PostgreSQL
  amazonaurorapostgresqldb: 'amazonRDSAuroraPostgreSQLCompatibleDB',
  amazonaurorapostgresql: 'amazonRDSAuroraPostgreSQLCompatibleDB',
  aurorapostgresql: 'amazonRDSAuroraPostgreSQLCompatibleDB',

  // MemoryDB
  amazonmemorydb: 'amazonMemoryDbForRedis',
  memorydb: 'amazonMemoryDbForRedis',
  amazonmemorydbforredis: 'amazonMemoryDbForRedis',

  // MSK (Managed Streaming for Kafka)
  amazonmsk: 'amazonManagedStreamingForApacheKafkaMsk',
  msk: 'amazonManagedStreamingForApacheKafkaMsk',
  amazonmanagedstreamingforkafka: 'amazonManagedStreamingForApacheKafkaMsk',

  // Mainframe Modernization
  awsmainframemodernization: 'mainframeBluAge',
  mainframemodernization: 'mainframeBluAge',
  bluage: 'mainframeBluAge',

  // PCS (Parallel Computing Service)
  amazonpcs: 'awsPcs',
  pcs: 'awsPcs',

  // Lambda
  lambda: 'aWSLambda',
  awslambda: 'aWSLambda',

  // S3
  amazons3: 'amazonS3',
  s3: 'amazonS3',

  // DynamoDB
  amazondynamodb: 'amazonDynamoDb',
  dynamodb: 'amazonDynamoDb',

  // CloudFront
  amazoncloudfront: 'amazonCloudFront',
  cloudfront: 'amazonCloudFront',

  // Route 53
  amazonroute53: 'amazonRoute53',
  route53: 'amazonRoute53',

  // CloudWatch
  amazoncloudwatch: 'amazonCloudWatch',
  cloudwatch: 'amazonCloudWatch',

  // Fargate
  fargate: 'awsFargate',
  awsfargate: 'awsFargate',

  // Step Functions
  stepfunctions: 'awsStepFunctions',
  awsstepfunctions: 'awsStepFunctions',

  // Kinesis Data Streams
  amazonkinesis: 'amazonKinesisDataStreams',
  kinesis: 'amazonKinesisDataStreams',
  amazonkinesisdatastreams: 'amazonKinesisDataStreams',

  // Kinesis Firehose / Data Firehose
  amazonkinesisfirehose: 'amazonKinesisFirehose',
  firehose: 'amazonKinesisFirehose',
  datafirehose: 'amazonKinesisFirehose',

  // Redshift
  amazonredshift: 'amazonRedshift',
  redshift: 'amazonRedshift',

  // ElastiCache
  amazonelasticache: 'amazonElastiCache',
  elasticache: 'amazonElastiCache',

  // Glue
  awsglue: 'awsGlue',
  glue: 'awsGlue',

  // Athena
  amazonathena: 'amazonAthena',
  athena: 'amazonAthena',

  // SageMaker
  amazonsagemaker: 'amazonSageMaker',
  sagemaker: 'amazonSageMaker',

  // Bedrock
  amazonbedrock: 'amazonBedrock',
  bedrock: 'amazonBedrock',

  // AppSync
  awsappsync: 'awsAppSync',
  appsync: 'awsAppSync',

  // API Gateway
  amazonapigateway: 'amazonApiGateway',
  apigateway: 'amazonApiGateway',

  // Cognito
  amazoncognito: 'amazonCognito',
  cognito: 'amazonCognito',

  // ECR
  amazonecr: 'amazonElasticContainerRegistry',
  ecr: 'amazonElasticContainerRegistry',
  amazonelasticcontainerregistry: 'amazonElasticContainerRegistry',

  // EFS
  amazonefs: 'amazonEFS',
  efs: 'amazonEFS',

  // EMR
  amazonemr: 'amazonEMR',
  emr: 'amazonEMR',

  // Neptune
  amazonneptune: 'amazonNeptune',
  neptune: 'amazonNeptune',

  // DocumentDB
  amazondocumentdb: 'amazonDocumentDB',
  documentdb: 'amazonDocumentDB',

  // Timestream
  amazontimestream: 'amazonTimestream',
  timestream: 'amazonTimestream',

  // QLDB
  amazonqldb: 'amazonQuantumLedgerDatabaseQldb',
  qldb: 'amazonQuantumLedgerDatabaseQldb',

  // Keyspaces (Cassandra)
  amazonkeyspaces: 'amazonKeyspaces',
  keyspaces: 'amazonKeyspaces',
  cassandra: 'amazonKeyspaces',

  // WAF
  awswaf: 'awsWebApplicationFirewall',
  waf: 'awsWebApplicationFirewall',

  // Direct Connect
  awsdirectconnect: 'awsDirectConnect',
  directconnect: 'awsDirectConnect',

  // Transfer Family
  awstransferfamily: 'aWSTransferForSFTP',
  awstransferforsftp: 'aWSTransferForSFTP',
  transferfamily: 'aWSTransferForSFTP',

  // Storage Gateway
  awsstoragegateway: 'aWSStorageGateway',
  storagegateway: 'aWSStorageGateway',

  // Data Transfer
  awsdatatransfer: 'aWSDataTransfer',
  datatransfer: 'aWSDataTransfer',

  // DataSync
  awsdatasync: 'aWSDataSync',
  datasync: 'aWSDataSync',

  // Directory Service
  awsdirectoryservice: 'aWSDirectoryService',
  directoryservice: 'aWSDirectoryService',

  // VPC
  amazonvpc: 'amazonVirtualPrivateCloud',
  vpc: 'amazonVirtualPrivateCloud',

  // SWF
  amazonswf: 'amazonSimpleWorkflowService',
  swf: 'amazonSimpleWorkflowService',

  // EventBridge
  amazoneventbridge: 'amazonEventBridge',
  eventbridge: 'amazonEventBridge',

  // Managed Workflows for Apache Airflow (MWAA)
  amazonmwaa: 'amazonManagedWorkflowsForApacheAirflow',
  mwaa: 'amazonManagedWorkflowsForApacheAirflow',

  // Managed Service for Apache Flink (was Kinesis Data Analytics)
  amazonkinesisdataanalytics: 'amazonKinesisDataAnalytics',
  apacheflink: 'amazonKinesisDataAnalytics',
  managedflink: 'amazonKinesisDataAnalytics',

  // Health Imaging
  awshealthimaging: 'amazonHealthImaging',
  healthimaging: 'amazonHealthImaging',

  // HealthOmics
  awshealthomics: 'amazonOmics',
  healthomics: 'amazonOmics',

  // Security Lake
  amazonsecuritylake: 'amazonSecurityLake',
  securitylake: 'amazonSecurityLake',

  // Network Firewall
  awsnetworkfirewall: 'amazonNetworkFirewall',
  networkfirewall: 'amazonNetworkFirewall',

  // Mainframe Modernization (full service page)
  amazonmainframemodernization: 'amazonMainframeModernization',

  // Q Developer (was CodeWhisperer)
  amazonqdeveloper: 'amazonCodeWhisperer',
  qdeveloper: 'amazonCodeWhisperer',
  codewhisperer: 'amazonCodeWhisperer',

  // Q Business
  amazonqbusiness: 'amazonQBusiness',
  qbusiness: 'amazonQBusiness',

  // Lightsail
  amazonlightsail: 'amazonLightsail',
  lightsail: 'amazonLightsail',

  // Amplify
  awsamplify: 'awsAmplify',
  amplify: 'awsAmplify',

  // App Runner
  awsapprunner: 'awsAppRunner',
  apprunner: 'awsAppRunner',

  // CloudHSM
  awscloudhsm: 'awsCloudHsm',
  cloudhsm: 'awsCloudHsm',

  // KMS
  awskms: 'awsKeyManagementService',
  kms: 'awsKeyManagementService',

  // Secrets Manager
  awssecretsmanager: 'awsSecretsManager',
  secretsmanager: 'awsSecretsManager',

  // CodeBuild
  awscodebuild: 'awsCodeBuild',
  codebuild: 'awsCodeBuild',

  // CodePipeline
  awscodepipeline: 'awsCodePipeline',
  codepipeline: 'awsCodePipeline',

  // CodeDeploy
  awscodedeploy: 'awsCodeDeploy',
  codedeploy: 'awsCodeDeploy',

  // CodeArtifact
  awscodeartifact: 'awsCodeArtifact',
  codeartifact: 'awsCodeArtifact',

  // CloudFormation
  awscloudformation: 'awsCloudFormation',
  cloudformation: 'awsCloudFormation',

  // CloudTrail
  awscloudtrail: 'awsCloudTrail',
  cloudtrail: 'awsCloudTrail',

  // Config
  awsconfig: 'awsConfig',
  config: 'awsConfig',

  // X-Ray
  awsxray: 'awsXRay',
  xray: 'awsXRay',

  // Systems Manager
  awssystemsmanager: 'awsSystemsManager',
  systemsmanager: 'awsSystemsManager',
  ssm: 'awsSystemsManager',

  // DMS
  awsdms: 'awsDatabaseMigrationService',
  awsdatabasemigrationservice: 'awsDatabaseMigrationService',
  dms: 'awsDatabaseMigrationService',

  // IoT Core
  awsiotcore: 'awsIoTCore',
  iotcore: 'awsIoTCore',

  // Rekognition
  amazonrekognition: 'amazonRekognition',
  rekognition: 'amazonRekognition',

  // Textract
  amazontextract: 'amazonTextract',
  textract: 'amazonTextract',

  // Comprehend
  amazoncomprehend: 'amazonComprehend',
  comprehend: 'amazonComprehend',

  // Polly
  amazonpolly: 'amazonPolly',
  polly: 'amazonPolly',

  // Transcribe
  amazontranscribe: 'amazonTranscribe',
  transcribe: 'amazonTranscribe',

  // Translate
  amazontranslate: 'amazonTranslate',
  translate: 'amazonTranslate',

  // Lex
  amazonlex: 'amazonLex',
  lex: 'amazonLex',

  // Personalize
  amazonpersonalize: 'amazonPersonalize',
  personalize: 'amazonPersonalize',

  // Kendra
  amazonkendra: 'amazonKendra',
  kendra: 'amazonKendra',

  // Forecast
  amazonforecast: 'amazonForecast',
  forecast: 'amazonForecast',

  // Fraud Detector
  amazonfrauddetector: 'amazonFraudDetector',
  frauddetector: 'amazonFraudDetector',

  // Macie
  amazonmacie: 'amazonMacie',
  macie: 'amazonMacie',

  // GuardDuty
  amazonguardduty: 'amazonGuardDuty',
  guardduty: 'amazonGuardDuty',

  // Inspector
  amazoninspector: 'amazonInspector',
  inspector: 'amazonInspector',

  // Detective
  amazondetective: 'amazonDetective',
  detective: 'amazonDetective',

  // SecurityHub
  awssecurityhub: 'awsSecurityHub',
  securityhub: 'awsSecurityHub',

  // Outposts
  awsoutposts: 'awsOutposts',
  outposts: 'awsOutposts',

  // Snow family
  awssnowball: 'awsSnowball',
  snowball: 'awsSnowball',

  // Backup
  awsbackup: 'awsBackup',
  backup: 'awsBackup',

  // Lake Formation
  awslakeformation: 'awsLakeFormation',
  lakeformation: 'awsLakeFormation',

  // Managed Grafana
  amazongrafana: 'amazonManagedGrafana',
  managedgrafana: 'amazonManagedGrafana',
  grafana: 'amazonManagedGrafana',

  // Managed Prometheus
  amazonprometheus: 'amazonManagedServiceForPrometheus',
  managedprometheus: 'amazonManagedServiceForPrometheus',
  prometheus: 'amazonManagedServiceForPrometheus',

  // Managed Blockchain
  amazonmanagedblockchain: 'amazonManagedBlockchain',
  managedblockchain: 'amazonManagedBlockchain',

  // ELB shortcuts
  alb: 'applicationLoadBalancer',
  elb: 'elasticLoadBalancing',
  nlb: 'networkLoadBalancer',
  gwlb: 'gatewayLoadBalancer',

  // FSx shortcuts
  fsxlustre: 'amazonFSxForLustre',
  amazonfsxforlustre: 'amazonFSxForLustre',
  fsxontap: 'amazonFSxForNetAppOntap',
  amazonfsxfornetappontap: 'amazonFSxForNetAppOntap',
  fsxopenzfs: 'amazonFSxForOpenZfs',
  amazonfsxforopenzfs: 'amazonFSxForOpenZfs',
  fsxwindows: 'amazonFSx',
  amazonfsxforwindows: 'amazonFSx',

  // RDS shortcuts
  rdsmysql: 'amazonRDSMySQLDB',
  amazonrdsmysql: 'amazonRDSMySQLDB',
  rdspostgresql: 'amazonRDSPostgreSQLDB',
  amazonrdspostgresql: 'amazonRDSPostgreSQLDB',
  rdsmariadb: 'amazonRDSMariaDB',
  amazonrdsmariadb: 'amazonRDSMariaDB',
  rdsdb2: 'amazonRdsForDb2',
  amazonrdsfordb2: 'amazonRdsForDb2',

  // WorkSpaces
  amazonworkspaces: 'amazonWorkSpaces',
  workspaces: 'amazonWorkSpaces',

  // Deadline Cloud (was Thinkbox)
  awsdeadlinecloud: 'awsDeadlineCloud',
  deadlinecloud: 'awsDeadlineCloud',

  // Pinpoint
  amazonpinpoint: 'amazonPinpoint',
  pinpoint: 'amazonPinpoint',

  // QuickSight
  amazonquicksight: 'amazonQuickSight',
  quicksight: 'amazonQuickSight',

  // Location Service
  amazonlocationservice: 'locationService',
  locationservice: 'locationService',

  // SimSpace Weaver (removed service — alias to help callers get a clear error)
  awssimspaceweaver: 'simSpaceWeaver',
  simspaceweaver: 'simSpaceWeaver',

  // Elastic Disaster Recovery
  awselasticdisasterrecovery: 'awsElasticDisasterRecovery',
  drs: 'awsElasticDisasterRecovery',

  // PrivateLink
  awsprivatelink: 'awsPrivateLinkVpc',
  privatelink: 'awsPrivateLinkVpc',

  // MQ
  amazonmq: 'amazonMQ',
  mq: 'amazonMQ',

  // App Fabric
  awsappfabric: 'awsAppFabric',
  appfabric: 'awsAppFabric',

  // Verified Permissions
  amazonverifiedpermissions: 'amazonVerifiedPermissions',
  verifiedpermissions: 'amazonVerifiedPermissions',
};

function findService(manifest, name) {
  const lower = name.toLowerCase();

  // 1. Exact case-insensitive match on manifest key
  for (const [key, svc] of manifest) {
    if (key.toLowerCase() === lower) return svc;
  }

  // 2. Check the alias map
  const aliasTarget = SERVICE_KEY_ALIASES[lower];
  if (aliasTarget) {
    const svc = manifest.get(aliasTarget);
    if (svc) return svc;
    // Alias target may also need case-insensitive lookup (edge cases)
    for (const [key, svc2] of manifest) {
      if (key.toLowerCase() === aliasTarget.toLowerCase()) return svc2;
    }
  }

  // 3. Fuzzy matching: case-insensitive partial match on key or service name
  //    Prefer exact substring match on key first, then name
  let bestByKey = null;
  let bestByName = null;
  for (const [key, svc] of manifest) {
    const keyLower = key.toLowerCase();
    const nameLower = (svc.name || '').toLowerCase();
    if (!bestByKey && keyLower.includes(lower)) {
      bestByKey = svc;
    }
    if (!bestByName && nameLower.includes(lower)) {
      bestByName = svc;
    }
    if (bestByKey) break; // key match takes priority; stop early
  }

  return bestByKey || bestByName || null;
}

function searchServices(manifest, query) {
  const terms = query.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const search = (term) => {
    const matches = [];
    for (const [key, svc] of manifest) {
      if (svc.subType === 'subServiceSelector') continue;
      if (svc.isActive === 'false') continue;
      const hit = key.toLowerCase().includes(term)
        || (svc.name && svc.name.toLowerCase().includes(term))
        || svc.searchKeywords?.some(kw => kw.toLowerCase().includes(term));
      if (hit) matches.push({ key, name: svc.name });
    }
    return matches;
  };
  if (terms.length === 1) return search(terms[0]);
  const results = {};
  for (const term of terms) results[term] = search(term);
  return results;
}

async function fetchServiceDefinition(manifest, serviceCode, partition = 'aws') {
  const cacheKey = `${partition}:${serviceCode}`;
  if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);

  const svc = manifest.get(serviceCode);
  if (!svc) return null;

  const urlPath = svc.serviceDefinitionUrlPath || `/data/${serviceCode}/en_US.json`;
  const cdnPrefix = PARTITIONS[partition]?.cdnPrefix || '';
  const res = await fetch(`${CDN_BASE}${cdnPrefix}${urlPath}`);
  if (!res.ok) throw new Error(`Definition fetch failed for ${serviceCode}: HTTP ${res.status}`);

  const definition = await res.json();
  definitionCache.set(cacheKey, definition);
  return definition;
}

function parseDoubleEncodedResponse(rawText) {
  let result;
  try { result = JSON.parse(rawText); }
  catch { throw new Error('AWS save API returned invalid JSON'); }

  let body;
  try { body = JSON.parse(result.body); }
  catch { throw new Error('AWS save API returned invalid body'); }

  if (!body.savedKey) {
    throw new Error(`AWS save API did not return a savedKey: ${JSON.stringify(body).substring(0, 200)}`);
  }
  return body;
}

async function saveEstimate(payload) {
  const jsonBody = JSON.stringify(payload);
  console.error(`[save] Sending ${jsonBody.length} bytes, ${Object.keys(payload.groups || {}).length} groups, ${Object.keys(payload.services || {}).length} ungrouped services`);
  const res = await fetch(SAVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Referer': 'https://calculator.aws/' },
    body: jsonBody,
  });
  const rawText = await res.text();
  if (!res.ok) {
    console.error(`[save] HTTP ${res.status}: ${rawText.substring(0, 500)}`);
    let detail;
    try {
      const body = parseDoubleEncodedResponse(rawText);
      detail = body.message || rawText.substring(0, 200);
    } catch {
      detail = rawText.substring(0, 200);
    }
    throw new Error(`AWS save API returned HTTP ${res.status}: ${detail}`);
  }
  const body = parseDoubleEncodedResponse(rawText);
  console.error(`[save] OK → ${body.savedKey}`);
  return {
    estimateId: body.savedKey,
    shareableUrl: `https://calculator.aws/#/estimate?id=${body.savedKey}`,
  };
}

const INPUT_TYPES = new Set([
  'input', 'numericInput', 'frequency', 'fileSize', 'durationInput', 'percentInput',
]);
const INPUT_SUBTYPES = new Set([
  'dropdown', 'numericInput', 'frequency', 'fileSize', 'durationInput',
  'columnFormIPM', 'dataTransferV2',
]);

// Human-readable hint describing the value shape the calculator
// frontend expects for a columnFormIPM composite widget. Exposed to
// agents so they can supply an already-shaped value without guessing.
const COLUMN_FORM_IPM_VALUE_SHAPE =
  'columnFormIPM expects {value: [rowObject]} — an array of one or more row objects. ' +
  'Each row is keyed by the selectorId (or label where no selectorId is defined; ' +
  'the utilization row uses the literal key "undefined"). Every cell wraps its value as ' +
  '{value: ...}. Example for RDS: {value: [{"Number of Nodes": {value: "1"}, ' +
  '"Instance Type": {value: "db.r6g.xlarge"}, "undefined": {value: {unit: "100", ' +
  'selectedId: "%Utilized/Month"}}, "Deployment Option": {value: "Single-AZ"}, ' +
  '"TermType": {value: "OnDemand"}}]}.';

function extractInputFields(definition) {
  const fields = [];
  const seen = new Set();

  const visit = (obj, templateId) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.id && (INPUT_TYPES.has(obj.type) || INPUT_SUBTYPES.has(obj.subType))) {
      const fieldType = obj.subType || obj.type;
      // Skip non-input decorative types
      if (['bodyText', 'headerText', 'alert'].includes(fieldType)) {
        // still walk into children — decorative wrappers may host inputs
      } else if (obj.id.includes('WithoutFreeTier') || obj.id.includes('_withoutFree') || obj.id.endsWith('_MVP')) {
        // Skip "without free tier" / MVP duplicate fields — these are alternate
        // versions of the same inputs for different pricing modes
      } else {
        // Deduplicate across templates by id+type. We still remember the
        // *first* template we found the field in, so agents can tell
        // which template a field belongs to when they are disjoint
        // (e.g. Amazon MQ's ActiveMQ vs RabbitMQ templates).
        const dedupKey = obj.id + ':' + fieldType;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);

          const field = { id: obj.id, type: fieldType };
          if (templateId) field.templateId = templateId;
          if (obj.label) field.label = obj.label;
          if (obj.options) {
            field.options = obj.options
              .filter(o => o.id !== undefined || o.label !== undefined)
              .map(o => {
                const opt = {};
                if (o.id !== undefined) opt.id = o.id;
                if (o.label) opt.label = o.label;
                return opt;
              });
          }
          if (obj.unit) field.unit = obj.unit;
          // fileSize fields: include valid size units and default unit format
          if (fieldType === 'fileSize') {
            const sizes = obj.dropDownSize?.map(s => s.value || s.id) || ['gb'];
            const defaultSize = obj.defaultOption?.size || obj.outputSize || 'gb';
            const defaultFreq = obj.defaultOption?.frequency || obj.outputFrequency || 'NA';
            field.unitFormat = `{value}|{size}|{frequency} — sizes: [${sizes.join(', ')}], default: "${defaultSize}|${defaultFreq}"`;
            field.validSizes = sizes;
            field.defaultUnit = `${defaultSize}|${defaultFreq}`;
          }
          // columnFormIPM composite: expose the row schema so an
          // agent can build the expected value shape without trial
          // and error. The calculator stores this as a matrix keyed
          // by selectorId (or label when no selectorId), with a
          // literal "undefined" key for the utilization row.
          if (fieldType === 'columnFormIPM') {
            field.mappingDefinitionName = obj.mappingDefinitionName || null;
            field.row = (obj.row || []).map(r => {
              const item = {
                label: r.label,
                selectorId: r.selectorId,
                type: r.type,
              };
              if (r.exportValueAs) item.exportValueAs = r.exportValueAs;
              if (r.isInstanceType) item.isInstanceType = true;
              if (r.mappingValue) item.mappingValue = r.mappingValue;
              return item;
            });
            field.valueShape = COLUMN_FORM_IPM_VALUE_SHAPE;
          }
          fields.push(field);
        }
      }
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(x => visit(x, templateId));
      else if (typeof v === 'object') visit(v, templateId);
    }
  };

  // Walk each template separately so fields can be tagged with their
  // owning template. This lets callers (agents, the estimate builder)
  // tell which template a given field belongs to when a service has
  // more than one (e.g. Amazon MQ → singleInstanceBroker vs
  // rabbitMQBroker).
  const templates = Array.isArray(definition.templates) ? definition.templates : null;
  if (templates && templates.length > 0) {
    for (const tpl of templates) visit(tpl, tpl.id);
  } else {
    visit(definition, null);
  }
  return fields;
}

/**
 * Enrich columnFormIPM fields with valid selector values from PLC_2.0 metadata.
 * Fetches metadata for each unique mappingDefinitionName in parallel.
 */
async function enrichFieldsWithMetadata(definition, fields) {
  const mappingDefs = definition.mappingDefinitions;
  if (!Array.isArray(mappingDefs) || mappingDefs.length === 0) return fields;

  // Collect unique mappingDefinitionNames referenced by columnFormIPM fields
  const needed = new Set();
  for (const f of fields) {
    if (f.type === 'columnFormIPM' && f.mappingDefinitionName) {
      needed.add(f.mappingDefinitionName);
    }
  }
  if (needed.size === 0) return fields;

  // Fetch all needed metadata in parallel
  const metadataMap = new Map();
  await Promise.all([...needed].map(async name => {
    const def = mappingDefs.find(d => d.mappingDefinitionName === name);
    const meta = await fetchMappingMetadata(def);
    if (meta) metadataMap.set(name, meta);
  }));

  // Attach selectorValues to each columnFormIPM field
  for (const f of fields) {
    if (f.type === 'columnFormIPM' && f.mappingDefinitionName) {
      const meta = metadataMap.get(f.mappingDefinitionName);
      if (meta) {
        // Only include selectors that match the field's row selectorIds
        const rowSelectors = new Set(f.row.map(r => r.selectorId).filter(Boolean));
        const values = {};
        for (const [key, vals] of Object.entries(meta.valueAttributes)) {
          if (rowSelectors.has(key)) values[key] = vals;
        }
        if (Object.keys(values).length > 0) f.selectorValues = values;
      }
    }
  }
  return fields;
}

const READ_URL = 'https://d3knqfixx3sbls.cloudfront.net';

async function fetchEstimate(estimateId) {
  const res = await fetch(`${READ_URL}/${estimateId}`);
  if (!res.ok) throw new Error(`Failed to fetch estimate: HTTP ${res.status}`);
  return res.json();
}

function estimateToMarkdown(data) {
  const lines = [`# ${data.name || 'AWS Estimate'}\n`];
  const total = data.totalCost;
  if (total) lines.push(`**Total Monthly Cost:** $${total.monthly?.toFixed(2) || '0.00'}${total.upfront ? ` | **Upfront:** $${total.upfront.toFixed(2)}` : ''}\n`);

  const renderServices = (services, indent = '') => {
    for (const [, svc] of Object.entries(services)) {
      const cost = svc.serviceCost?.monthly != null ? ` — $${svc.serviceCost.monthly.toFixed(2)}/mo` : '';
      lines.push(`${indent}- **${svc.serviceName}** (${svc.regionName})${cost}`);
      if (svc.description) lines.push(`${indent}  - Description: ${svc.description}`);
      if (svc.configSummary) lines.push(`${indent}  - Config: ${svc.configSummary}`);
    }
  };

  if (data.services && Object.keys(data.services).length > 0) {
    lines.push('## Services\n');
    renderServices(data.services);
  }

  if (data.groups) {
    for (const [, group] of Object.entries(data.groups)) {
      lines.push(`\n## ${group.name || 'Group'}\n`);
      if (group.totalCost?.monthly != null) lines.push(`**Group Monthly:** $${group.totalCost.monthly.toFixed(2)}\n`);
      if (group.services) renderServices(group.services);
    }
  }

  return lines.join('\n');
}

module.exports = { PARTITIONS, resolvePartition, loadManifest, findService, searchServices, fetchServiceDefinition, saveEstimate, extractInputFields, enrichFieldsWithMetadata, parseDoubleEncodedResponse, fetchEstimate, estimateToMarkdown };
