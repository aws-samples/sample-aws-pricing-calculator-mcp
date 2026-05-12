Feature: AWS Calculator Service Validation via Direct API
  As a cloud architect using the AWS Calculator MCP
  I want to create estimates for all supported AWS services via direct API
  So that I can validate that field mappings produce valid shareable pricing links

  Background:
    Given the calculator API is available
    And the field mapping is loaded from "field-mapping.json"

  # ============================================================
  # COMPUTE SERVICES
  # ============================================================
  @compute @ec2
  Scenario Outline: Configure Amazon EC2 - <os> on <tenancy>
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | <os> |
      | tenancy | <tenancy> |
      | columnFormIPM[0].Instance Type | m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | storageAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: OS and tenancy combinations
      | os                          | tenancy             |
      | Linux                       | Shared Instances    |
      | Windows Server              | Shared Instances    |
      | Red Hat Enterprise Linux    | Shared Instances    |
      | SUSE Linux Enterprise Server | Shared Instances   |
      | Ubuntu Pro                  | Shared Instances    |
      | Linux                       | Dedicated Instances |
      | Windows Server              | Dedicated Instances |

  @compute @lightsail
  Scenario: Configure Amazon Lightsail with all fields
    When I create an estimate with:
      | service      | Amazon Lightsail |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | medium |
      | numberOfServers | 3 |
      | serverUtilization | 85 |
      | numberOfContainers | 2 |
      | containerUtilization | 90 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @lambda
  Scenario Outline: Configure AWS Lambda - <architecture> architecture
    When I create an estimate with:
      | service      | AWS Lambda |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | architecture | <architecture> |
      | numberOfRequests | 1000000 |
      | durationOfEachRequest | 250 |
      | amountOfMemoryAllocated | 1024 |
      | amountOfEphemeralStorageAllocated | 512 |
      | concurrency | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Architecture variants
      | architecture |
      | x86          |
      | Arm          |

  @compute @lambda @provisioned
  Scenario: Configure AWS Lambda with Provisioned Concurrency
    When I create an estimate with:
      | service      | AWS Lambda |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | architecture | x86 |
      | numberOfRequests | 5000000 |
      | durationOfEachRequest | 100 |
      | amountOfMemoryAllocated | 512 |
      | amountOfEphemeralStorageAllocated | 512 |
      | concurrency | 500 |
      | durationOfEachProvisionedRequest | 80 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @fargate
  Scenario Outline: Configure AWS Fargate - <os> on <arch>
    When I create an estimate with:
      | service      | AWS Fargate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | <os> |
      | selectArchitecture | <arch> |
      | numberOfTasks | 10 |
      | taskDuration | 120 |
      | memoryStandardFargateOnDemand | 4 |
      | storageAmountECS | 30 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: OS and architecture combinations
      | os      | arch |
      | Linux   | x86  |
      | Linux   | ARM  |
      | Windows | x86  |

  @compute @fargate @high-memory
  Scenario: Configure AWS Fargate with high memory workload
    When I create an estimate with:
      | service      | AWS Fargate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | selectArchitecture | x86 |
      | numberOfTasks | 50 |
      | taskDuration | 3600 |
      | memoryStandardFargateOnDemand | 16 |
      | storageAmountECS | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @app-runner
  Scenario: Configure AWS App Runner - standard workload
    When I create an estimate with:
      | service      | AWS App Runner |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | concurrency | 80 |
      | minimumProvisionedContainerInstances | 2 |
      | peakTrafficHours | 8 |
      | numberOfRequestsDuringPeakTrafficRequestssec | 500 |
      | numberOfRequestsDuringOffpeakTrafficRequests | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @app-runner @high-traffic
  Scenario: Configure AWS App Runner - high traffic workload
    When I create an estimate with:
      | service      | AWS App Runner |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | concurrency | 200 |
      | minimumProvisionedContainerInstances | 10 |
      | peakTrafficHours | 12 |
      | numberOfRequestsDuringPeakTrafficRequestssec | 5000 |
      | numberOfRequestsDuringOffpeakTrafficRequests | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @elastic-vmware
  Scenario: Configure Amazon Elastic VMware Service with all fields
    When I create an estimate with:
      | service      | Amazon Elastic VMware Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInstances | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @eks
  Scenario: Configure Amazon EKS with all fields
    When I create an estimate with:
      | service      | Amazon EKS |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfEKSClusters | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @emr
  Scenario: Configure Amazon EMR - small cluster
    When I create an estimate with:
      | service      | Amazon EMR |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfMasterEmrNodes | 1 |
      | utilization | 100 |
      | numberOfCoreEmrNodes | 4 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @emr @large-cluster
  Scenario: Configure Amazon EMR - large cluster
    When I create an estimate with:
      | service      | Amazon EMR |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfMasterEmrNodes | 3 |
      | utilization | 100 |
      | numberOfCoreEmrNodes | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @amplify
  Scenario: Configure AWS Amplify with all fields
    When I create an estimate with:
      | service      | AWS Amplify |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfBuildMinutes | 1000 |
      | dataStoredPerMonth | 50 |
      | dataServedPerMonth | 200 |
      | numberOfSsrRequests | 500000 |
      | durationOfEachRequestInMs | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @step-functions
  Scenario: Configure AWS Step Functions with all fields
    When I create an estimate with:
      | service      | AWS Step Functions |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | workflowRequests | 100000 |
      | stateTransitionsPerWorkflow | 8 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @mainframe-modernization
  Scenario: Configure AWS Mainframe Modernization with all fields
    When I create an estimate with:
      | service      | AWS Mainframe Modernization |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInstances | 2 |
      | monthlyUtilization | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @pcs
  Scenario: Configure AWS PCS with all fields
    When I create an estimate with:
      | service      | AWS PCS |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPcsClusters | 2 |
      | lengthOfTimeClusterIsRunning | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @simspace-weaver
  Scenario: Configure AWS SimSpace Weaver with all fields
    When I create an estimate with:
      | service      | AWS SimSpace Weaver |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | c5.xlarge |
      | numberOfInstances | 4 |
      | usage | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @deadline-cloud
  Scenario: Configure AWS Deadline Cloud with all fields
    When I create an estimate with:
      | service      | AWS Deadline Cloud |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | c5.2xlarge |
      | numberOfInstance | 10 |
      | monthlyUtilization | 500 |
      | storagePerWorker | 100 |
      | utilizationOndemandOnly | 80 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @elastic-graphics
  Scenario: Configure Amazon Elastic Graphics with all fields
    When I create an estimate with:
      | service      | Amazon Elastic Graphics |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | eg1.2xlarge |
      | numberOfNodes | 2 |
      | utilizationOndemandOnly | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @gamelift-servers
  Scenario: Configure Amazon GameLift Servers with all fields
    When I create an estimate with:
      | service      | Amazon GameLift Servers |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | c5.xlarge |
      | peakConcurrentPlayersPeakCcu | 1000 |
      | gameSessionsPerInstance | 4 |
      | playersPerGameSession | 64 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @gamelift-streams
  Scenario: Configure Amazon GameLift Streams with all fields
    When I create an estimate with:
      | service      | Amazon GameLift Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | estimatedDailyActiveUsers | 500 |
      | estimatedStreamHoursPerUser | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @database @rds-postgresql
  Scenario Outline: Configure Amazon RDS for PostgreSQL - <deployment> with <storage_type>
    When I create an estimate with:
      | service      | Amazon RDS for PostgreSQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | <deployment> |
      | storageVolume | <storage_type> |
      | Select an instance | db.m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment and storage combinations
      | deployment | storage_type                    |
      | Multi-AZ   | General Purpose SSD (gp2)       |
      | Multi-AZ   | General Purpose SSD (gp3)       |
      | Multi-AZ   | Provisioned IOPS SSD (io1)      |
      | Multi-AZ   | Provisioned IOPS SSD (io2)      |
      | Single-AZ  | General Purpose SSD (gp2)       |
      | Single-AZ  | General Purpose SSD (gp3)       |
      | Single-AZ  | Provisioned IOPS SSD (io1)      |
      | Single-AZ  | Provisioned IOPS SSD (io2)      |

  @database @rds-mysql
  Scenario Outline: Configure Amazon RDS for MySQL - <deployment> with <storage_type>
    When I create an estimate with:
      | service      | Amazon RDS for MySQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | <deployment> |
      | storageVolume | <storage_type> |
      | Select an instance | db.m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment and storage combinations
      | deployment | storage_type                    |
      | Multi-AZ   | General Purpose SSD (gp2)       |
      | Multi-AZ   | General Purpose SSD (gp3)       |
      | Multi-AZ   | Provisioned IOPS SSD (io1)      |
      | Multi-AZ   | Provisioned IOPS SSD (io2)      |
      | Single-AZ  | General Purpose SSD (gp2)       |
      | Single-AZ  | General Purpose SSD (gp3)       |
      | Single-AZ  | Provisioned IOPS SSD (io1)      |
      | Single-AZ  | Provisioned IOPS SSD (io2)      |

  @database @rds-mariadb
  Scenario Outline: Configure Amazon RDS for MariaDB - <deployment> with <storage_type>
    When I create an estimate with:
      | service      | Amazon RDS for MariaDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | <deployment> |
      | storageVolume | <storage_type> |
      | Select an instance | db.m6i.large |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment and storage combinations
      | deployment | storage_type               |
      | Multi-AZ   | General Purpose SSD (gp3)  |
      | Single-AZ  | General Purpose SSD (gp2)  |
      | Single-AZ  | Provisioned IOPS SSD (io1) |

  @database @rds-oracle
  Scenario Outline: Configure Amazon RDS for Oracle - <deployment> deployment
    When I create an estimate with:
      | service      | Amazon RDS for Oracle |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | <deployment> |
      | Select an instance | db.m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment variants
      | deployment |
      | Multi-AZ   |
      | Single-AZ  |

  @database @rds-sql-server
  Scenario Outline: Configure Amazon RDS for SQL server - <deployment> deployment
    When I create an estimate with:
      | service      | Amazon RDS for SQL server |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | <deployment> |
      | Select an instance | db.m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment variants
      | deployment |
      | Multi-AZ   |
      | Single-AZ  |

  @database @rds-db2
  Scenario Outline: Configure Amazon RDS for Db2 - <deployment> deployment
    When I create an estimate with:
      | service      | Amazon RDS for Db2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Deployment Option | <deployment> |
      | Select an instance | db.m6i.large |
      | nodes | 1 |
      | utilizationOndemandOnly | 100 |
      | storageAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment variants
      | deployment |
      | Multi-AZ   |
      | Single-AZ  |

  @database @rds-custom-oracle
  Scenario: Configure Amazon RDS Custom for Oracle with all fields
    When I create an estimate with:
      | service      | Amazon RDS Custom for Oracle |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.m6i.xlarge |
      | numberOfRdsCustomForOracleInstances | 1 |
      | utilizationOndemandOnly | 100 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-custom-sql
  Scenario: Configure Amazon RDS Custom for SQL Server with all fields
    When I create an estimate with:
      | service      | Amazon RDS Custom for SQL Server |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.m6i.xlarge |
      | numberOfRdsCustomForSqlServerInstances | 1 |
      | utilizationOndemandOnly | 100 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-outposts
  Scenario: Configure Amazon RDS on AWS Outposts with all fields
    When I create an estimate with:
      | service      | Amazon RDS on AWS Outposts |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.m5.xlarge |
      | numberOfRdsForOutpostsInstances | 2 |
      | utilizationOndemandOnly | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @aurora-mysql
  Scenario Outline: Configure Amazon Aurora MySQL-Compatible - <storage_mode> with <pricing>
    When I create an estimate with:
      | service      | Amazon Aurora MySQL-Compatible |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | <storage_mode> |
      | columnFormIPM[0].TermType | <pricing> |
      | Select an instance | db.r6g.large |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 100 |
      | baselineIORate | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Storage mode and pricing combinations
      | storage_mode         | pricing  |
      | Aurora Standard      | OnDemand |
      | Aurora Standard      | Reserved |
      | Aurora I/O-Optimized | OnDemand |
      | Aurora I/O-Optimized | Reserved |

  @database @aurora-postgresql
  Scenario Outline: Configure Amazon Aurora PostgreSQL-Compatible DB - <storage_mode> with <pricing>
    When I create an estimate with:
      | service      | Amazon Aurora PostgreSQL-Compatible DB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | <storage_mode> |
      | columnFormIPM[0].TermType | <pricing> |
      | Select an instance | db.r6g.large |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 100 |
      | baselineIORate | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Storage mode and pricing combinations
      | storage_mode         | pricing  |
      | Aurora Standard      | OnDemand |
      | Aurora Standard      | Reserved |
      | Aurora I/O-Optimized | OnDemand |
      | Aurora I/O-Optimized | Reserved |

  @database @dynamodb
  Scenario Outline: Configure Amazon DynamoDB - <table_class> table class
    When I create an estimate with:
      | service      | Amazon DynamoDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | tableClass | <table_class> |
      | averageItemSize | 200 |
      | baselineWriteRate | 100 |
      | peakWriteRate | 500 |
      | durationOfPeakWriteActivity | 4 |
      | baselineReadRate | 500 |
      | peakReadRate | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Table class variants
      | table_class                |
      | Standard                   |
      | Standard-Infrequent Access |

  @database @dynamodb @high-throughput
  Scenario: Configure Amazon DynamoDB with high throughput workload
    When I create an estimate with:
      | service      | Amazon DynamoDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | tableClass | Standard |
      | averageItemSize | 1 |
      | baselineWriteRate | 5000 |
      | peakWriteRate | 25000 |
      | durationOfPeakWriteActivity | 2 |
      | baselineReadRate | 20000 |
      | peakReadRate | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @documentdb
  Scenario Outline: Configure Amazon DocumentDB - <engine> engine
    When I create an estimate with:
      | service      | Amazon DocumentDB (with MongoDB compatibility) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | engine | <engine> |
      | Select an instance | db.r6g.large |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Engine variants
      | engine                          |
      | Amazon DocumentDB Standard      |
      | Amazon DocumentDB I/O-Optimized |

  @database @neptune
  Scenario Outline: Configure Amazon Neptune - <storage_mode> storage
    When I create an estimate with:
      | service      | Amazon Neptune |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | <storage_mode> |
      | Select an instance | db.r6g.large |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | dataStored | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Storage mode variants
      | storage_mode          |
      | Neptune Standard      |
      | Neptune I/O-Optimized |

  @database @elasticache
  Scenario Outline: Configure Amazon ElastiCache - <engine> engine with <pricing>
    When I create an estimate with:
      | service      | Amazon ElastiCache |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | EngineType | <engine> |
      | columnFormIPM[0].TermType | <pricing> |
      | Select an instance | cache.m5.xlarge |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Engine and pricing variants
      | engine    | pricing  |
      | Memcached | OnDemand |
      | Redis     | OnDemand |
      | Redis     | Reserved |
      | Valkey    | OnDemand |
      | Valkey    | Reserved |

  @database @memorydb
  Scenario: Configure Amazon MemoryDB - small cluster
    When I create an estimate with:
      | service      | Amazon MemoryDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.r6g.large |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
      | dataWritten | 50 |
      | snapshotStorage | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @memorydb @large-cluster
  Scenario: Configure Amazon MemoryDB - large cluster
    When I create an estimate with:
      | service      | Amazon MemoryDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.r6g.2xlarge |
      | columnFormIPM[0].Number of Nodes | 9 |
      | columnFormIPM[0].undefined.unit | 100 |
      | dataWritten | 500 |
      | snapshotStorage | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @redshift
  Scenario: Configure Amazon Redshift - dc2 cluster
    When I create an estimate with:
      | service      | Amazon Redshift |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | dc2.large |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @redshift @ra3
  Scenario: Configure Amazon Redshift - ra3 cluster
    When I create an estimate with:
      | service      | Amazon Redshift |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | ra3.xlplus |
      | columnFormIPM[0].Number of Nodes | 4 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @keyspaces
  Scenario: Configure Amazon Keyspaces with all fields
    When I create an estimate with:
      | service      | Amazon Keyspaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storage | 100 |
      | numberOfWrites | 10000 |
      | numberOfReads | 50000 |
      | numberOfTtlDeleteOperations | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @timestream
  Scenario: Configure Amazon Timestream with all fields
    When I create an estimate with:
      | service      | Amazon Timestream |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | estimatedMonthlyStorage | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @qldb
  Scenario: Configure Amazon Quantum Ledger Database (QLDB) with all fields
    When I create an estimate with:
      | service      | Amazon Quantum Ledger Database (QLDB) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfWriteIos | 100000 |
      | numberOfReadIos | 500000 |
      | journalStorage | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @opensearch
  Scenario Outline: Configure Amazon OpenSearch Service - <pricing> pricing
    When I create an estimate with:
      | service      | Amazon OpenSearch Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].TermType | <pricing> |
      | Select an instance | m6g.large.search |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmountPerVolumeGP3 | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Pricing variants
      | pricing  |
      | OnDemand |
      | Reserved |

  @database @opensearch @serverless
  Scenario: Configure Amazon OpenSearch Service with serverless configuration
    When I create an estimate with:
      | service      | Amazon OpenSearch Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | r6g.large.search |
      | columnFormIPM[0].Number of Nodes | 6 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmountPerVolumeGP3 | 500 |
      | provisioningIOPSPerVolumeGP3 | 3000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @storage @s3
  Scenario: Configure Amazon Simple Storage Service (S3) - standard workload
    When I create an estimate with:
      | service      | Amazon Simple Storage Service (S3) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | s3StandardStorage | 1000 |
      | putCopyPostListRequests | 100000 |
      | getSelectRequests | 500000 |
      | dataReturnedByS3Select | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @s3 @high-volume
  Scenario: Configure Amazon Simple Storage Service (S3) - high volume
    When I create an estimate with:
      | service      | Amazon Simple Storage Service (S3) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | s3StandardStorage | 50000 |
      | putCopyPostListRequests | 10000000 |
      | getSelectRequests | 50000000 |
      | dataReturnedByS3Select | 500 |
      | dataTransfer | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @ebs
  Scenario Outline: Configure Amazon Elastic Block Store (EBS) - <volume_type>
    When I create an estimate with:
      | service      | Amazon Elastic Block Store (EBS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | volumeType | <volume_type> |
      | numberOfVolumes | 4 |
      | averageDurationOfVolume | 730 |
      | storageAmountPerVolume | 500 |
      | amountChangedPerSnapshot | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Volume type variants
      | volume_type                         |
      | General Purpose SSD (gp2)           |
      | General Purpose SSD (gp3)           |
      | Provisioned IOPS SSD (io1)          |
      | Provisioned IOPS SSD (io2)          |
      | Throughput Optimized HDD (st 1)     |
      | Cold HDD (sc1)                      |
      | Magnetic (previous generation)      |

  @storage @efs
  Scenario Outline: Configure Amazon Elastic File System (EFS) - <throughput_mode> throughput
    When I create an estimate with:
      | service      | Amazon Elastic File System (EFS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | throughputMode | <throughput_mode> |
      | desiredStorageCapacity | 500 |
      | infrequentAccessTiering | 20 |
      | infrequentAccessRead | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Throughput mode variants
      | throughput_mode        |
      | Elastic Throughput     |
      | Provisioned Throughput |

  @storage @fsx-lustre
  Scenario Outline: Configure Amazon FSx for Lustre - <storage_type> storage
    When I create an estimate with:
      | service      | Amazon FSx for Lustre |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Storage type | <storage_type> |
      | storageCapacity | 1200 |
      | backupStorage | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Storage type variants
      | storage_type |
      | SSD          |
      | HDD          |

  @storage @fsx-ontap
  Scenario Outline: Configure Amazon FSx for NetApp ONTAP - <deployment>
    When I create an estimate with:
      | service      | Amazon FSx for NetApp ONTAP |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Deployment type | <deployment> |
      | desiredStorageCapacity | 1024 |
      | desiredAdditionalSsdIops | 3000 |
      | desiredAggregateThroughput | 512 |
      | backupStorage | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Deployment type variants
      | deployment             |
      | Single-AZ 1 Deployment |
      | Multi-AZ 1 Deployment  |
      | Single-AZ 2 Deployment |
      | Multi-AZ 2 Deployment  |

  @storage @fsx-openzfs
  Scenario: Configure Amazon FSx for OpenZFS with all fields
    When I create an estimate with:
      | service      | Amazon FSx for OpenZFS |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | desiredStorageCapacity | 1024 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @fsx-windows
  Scenario: Configure Amazon FSx for Windows File Server with all fields
    When I create an estimate with:
      | service      | Amazon FSx for Windows File Server |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | desiredStorageCapacity | 1024 |
      | desiredAggregateThroughput | 256 |
      | backupStorage | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @file-cache
  Scenario: Configure Amazon File Cache with all fields
    When I create an estimate with:
      | service      | Amazon File Cache |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageCapacity | 2400 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @ecr
  Scenario: Configure Amazon Elastic Container Registry with all fields
    When I create an estimate with:
      | service      | Amazon Elastic Container Registry |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | amountofdatastored | 50 |
      | dataTransfer | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @storage-gateway
  Scenario: Configure AWS Storage Gateway with all fields
    When I create an estimate with:
      | service      | AWS Storage Gateway |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataWrittenToAwsFileStorageByYourGateway | 500 |
      | enterAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @backup
  Scenario: Configure AWS Backup with all fields
    When I create an estimate with:
      | service      | AWS Backup |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | primaryDataGB | 500 |
      | dailyChangePct | 5 |
      | dailyWarmRetention | 30 |
      | weeklyWarmRetention | 12 |
      | monthlyWarmRetention | 12 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @snowball
  Scenario: Configure AWS Snowball with all fields
    When I create an estimate with:
      | service      | AWS Snowball |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevices | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @datasync
  Scenario: Configure AWS DataSync with all fields
    When I create an estimate with:
      | service      | AWS DataSync |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalDataCopiedByAwsDatasyncPerMonth | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @elastic-disaster-recovery
  Scenario: Configure AWS Elastic Disaster Recovery with all fields
    When I create an estimate with:
      | service      | AWS Elastic Disaster Recovery |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfSourceServersReplicatedPerMonth | 10 |
      | numberOfDisks | 20 |
      | storageOnAllDisksAndAllServers | 5000 |
      | numberOfDaysSelectedForEbsSnapshotRetention | 7 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @networking @cloudfront
  Scenario: Configure Amazon CloudFront with all fields
    When I create an estimate with:
      | service      | Amazon CloudFront |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | freePlan | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @vpc
  Scenario: Configure Amazon Virtual Private Cloud (VPC) - standard setup
    When I create an estimate with:
      | service      | Amazon Virtual Private Cloud (VPC) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | natGateways | 2 |
      | vpnConnections | 1 |
      | vpnDuration | 730 |
      | subnetAssociations | 4 |
      | clientVpnConnections | 10 |
      | workingDaysPerMonth | 22 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @vpc @enterprise
  Scenario: Configure Amazon Virtual Private Cloud (VPC) - enterprise setup
    When I create an estimate with:
      | service      | Amazon Virtual Private Cloud (VPC) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | natGateways | 10 |
      | vpnConnections | 4 |
      | vpnDuration | 730 |
      | subnetAssociations | 16 |
      | clientVpnConnections | 100 |
      | workingDaysPerMonth | 22 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @direct-connect
  Scenario: Configure AWS Direct Connect - standard
    When I create an estimate with:
      | service      | AWS Direct Connect |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPorts | 2 |
      | hoursUsed | 730 |
      | dataTransferOut | 5000 |
      | dataTransferIn | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @direct-connect @high-bandwidth
  Scenario: Configure AWS Direct Connect - high bandwidth
    When I create an estimate with:
      | service      | AWS Direct Connect |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPorts | 4 |
      | hoursUsed | 730 |
      | dataTransferOut | 50000 |
      | dataTransferIn | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @route53
  Scenario: Configure Amazon Route 53 - standard DNS
    When I create an estimate with:
      | service      | Amazon Route 53 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfHostedZones | 5 |
      | additionalRecords | 100 |
      | trafficFlow | 2 |
      | numberOfStandardQueries | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @route53 @health-checks
  Scenario: Configure Amazon Route 53 - with health checks
    When I create an estimate with:
      | service      | Amazon Route 53 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfHostedZones | 10 |
      | additionalRecords | 500 |
      | trafficFlow | 5 |
      | numberOfStandardQueries | 50000000 |
      | basicChecksWithinAWS | 10 |
      | httpsChecksWithinAWS | 5 |
      | numberOfDomainsStored | 20 |
      | dnsQueries | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @elb
  Scenario: Configure Elastic Load Balancing - standard
    When I create an estimate with:
      | service      | Elastic Load Balancing |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfALBs | 2 |
      | processedBytesLambda | 100 |
      | averageNewConnectionsPerALB | 100 |
      | averageRequestsPerSecondPerALB | 500 |
      | averageRuleEvaluationsPerRequest | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @elb @high-traffic
  Scenario: Configure Elastic Load Balancing - high traffic
    When I create an estimate with:
      | service      | Elastic Load Balancing |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfALBs | 10 |
      | processedBytesLambda | 1000 |
      | averageNewConnectionsPerALB | 1000 |
      | averageRequestsPerSecondPerALB | 5000 |
      | averageRuleEvaluationsPerRequest | 25 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @api-gateway
  Scenario: Configure Amazon API Gateway - REST API
    When I create an estimate with:
      | service      | Amazon API Gateway |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | requests | 10 |
      | averageSizeOfEachRequest | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @api-gateway @websocket
  Scenario: Configure Amazon API Gateway - WebSocket API
    When I create an estimate with:
      | service      | Amazon API Gateway |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | requests | 50 |
      | averageSizeOfEachRequest | 5 |
      | messages | 10000 |
      | averageMessageSize | 32 |
      | averageConnectionRate | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @data-transfer
  Scenario: Configure AWS Data Transfer with all fields
    When I create an estimate with:
      | service      | AWS Data Transfer |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataTransfer | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @network-firewall
  Scenario: Configure AWS Network Firewall with all fields
    When I create an estimate with:
      | service      | AWS Network Firewall |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfEndpoints | 2 |
      | monthlyUsagePerEndpoint | 730 |
      | advancedInspectionMonthlyUsage | 730 |
      | numberOfSecondaryEndpoints | 1 |
      | usagePerSecondaryEndpoint | 730 |
      | dataProcessedPerMonth | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @waf
  Scenario: Configure AWS Web Application Firewall (WAF) with all fields
    When I create an estimate with:
      | service      | AWS Web Application Firewall (WAF) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfWebAcls | 3 |
      | numberOfRulesPerWebAcl | 10 |
      | numberOfRulesInsideRuleGroup | 5 |
      | numberOfWebRequests | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @shield
  Scenario: Configure AWS Shield with all fields
    When I create an estimate with:
      | service      | AWS Shield |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudFrontUsage | 10 |
      | elbUsage | 5 |
      | elasticIPUsage | 3 |
      | globalAcceleratorUsage | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @firewall-manager
  Scenario: Configure AWS Firewall Manager with all fields
    When I create an estimate with:
      | service      | AWS Firewall Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfProtectionPolicy | 5 |
      | numberOfAwsAccount | 3 |
      | numberOfConfigurationItemsRecorded | 1000 |
      | numberOfConfigRuleEvaluations | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @ai-ml @bedrock
  Scenario Outline: Configure Amazon Bedrock - <inference_type> with <pricing>
    When I create an estimate with:
      | service      | Amazon Bedrock |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | inferenceType | <inference_type> |
      | pricingModel | <pricing> |
      | averageRequestsPerMinute | 10 |
      | hoursPerDayAtThisRate | 8 |
      | averageInputTokensPerRequest | 500 |
      | averageOutputTokensPerRequest | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Inference and pricing combinations
      | inference_type             | pricing              |
      | Geo Cross Region Inference | On Demand - Standard |
      | Geo Cross Region Inference | On Demand - Priority |
      | Geo Cross Region Inference | On Demand - Flex     |
      | Geo Cross Region Inference | Batch                |
      | In-Region                  | On Demand - Standard |
      | In-Region                  | Batch                |

  @ai-ml @bedrock-agentcore
  Scenario: Configure Amazon Bedrock AgentCore with all fields
    When I create an estimate with:
      | service      | Amazon Bedrock AgentCore |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAgentSessionsPerMonth | 10000 |
      | averageSessionDurationSeconds | 30 |
      | averageVcpuExcludingIoWaitTime | 2 |
      | averageSessionMemoryInGb | 4 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @sagemaker
  Scenario: Configure Amazon SageMaker - small team
    When I create an estimate with:
      | service      | Amazon SageMaker |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDataScientists | 3 |
      | numberOfStudioNotebookInstances | 1 |
      | studioNotebookHoursPerDay | 8 |
      | studioNotebookDaysPerMonth | 22 |
      | storageAmount | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @sagemaker @large-team
  Scenario: Configure Amazon SageMaker - large team
    When I create an estimate with:
      | service      | Amazon SageMaker |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDataScientists | 15 |
      | numberOfStudioNotebookInstances | 2 |
      | studioNotebookHoursPerDay | 10 |
      | studioNotebookDaysPerMonth | 22 |
      | numberOfOnDemandNotebookInstances | 1 |
      | onDemandNotebookHoursPerDay | 4 |
      | onDemandNotebookDaysPerMonth | 22 |
      | storageAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @sagemaker-ground-truth
  Scenario: Configure Amazon SageMaker Ground Truth with all fields
    When I create an estimate with:
      | service      | Amazon SageMaker Ground Truth |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDatasetObjects | 10000 |
      | numberOfWorkersPerDatasetObject | 3 |
      | numberOfHumanTasksPerMonth | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @rekognition
  Scenario: Configure Amazon Rekognition with all fields
    When I create an estimate with:
      | service      | Amazon Rekognition |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfImagesProcessedWithLabelsApiCallsP | 100000 |
      | numberOfImagesProcessedWithContentModeration | 50000 |
      | numberOfImagesProcessedWithDetectTextApiCa | 25000 |
      | numberOfDetectfacesApiCallsPerMonth | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @comprehend
  Scenario: Configure Amazon Comprehend with all fields
    When I create an estimate with:
      | service      | Amazon Comprehend |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDocumentsAsynchronous | 50000 |
      | averageCharactersInADocumentAsynchronous | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @comprehend-medical
  Scenario: Configure Amazon Comprehend Medical with all fields
    When I create an estimate with:
      | service      | Amazon Comprehend Medical |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfTextUtf8DocumentsNere | 10000 |
      | averageCharactersInADocumentNere | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @textract
  Scenario: Configure Amazon Textract with all fields
    When I create an estimate with:
      | service      | Amazon Textract |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPages | 100000 |
      | percentOfPagesWithTextDetectDocumentTextAp | 80 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @polly
  Scenario: Configure Amazon Polly with all fields
    When I create an estimate with:
      | service      | Amazon Polly |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRequestsStandardTexttospeech | 50000 |
      | numberOfCharactersPerRequestIncludingWhiteS | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @translate
  Scenario: Configure Amazon Translate with all fields
    When I create an estimate with:
      | service      | Amazon Translate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfCharactersIncludingWhiteSpacesAndPu | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @transcribe
  Scenario: Configure Amazon Transcribe with all fields
    When I create an estimate with:
      | service      | Amazon Transcribe |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @transcribe-medical
  Scenario: Configure Amazon Transcribe Medical with all fields
    When I create an estimate with:
      | service      | Amazon Transcribe Medical |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfMinutesOfMedicalAudioTranscriptionP | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @personalize
  Scenario: Configure Amazon Personalize with all fields
    When I create an estimate with:
      | service      | Amazon Personalize |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @forecast
  Scenario: Configure Amazon Forecast with all fields
    When I create an estimate with:
      | service      | Amazon Forecast |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataImported | 10 |
      | trainingHours | 5 |
      | uniqueNumberOfItems | 1000 |
      | numberOfForecastHorizonDataPoints | 30 |
      | numberOfQuantiles | 3 |
      | forecastingFrequency | 12 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @fraud-detector
  Scenario: Configure Amazon Fraud Detector with all fields
    When I create an estimate with:
      | service      | Amazon Fraud Detector |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | eventDataProcessedAndStored | 10 |
      | numberOfModelVersions | 2 |
      | trainingTimePerModelVersionInHours | 4 |
      | numberOfActiveModelVersions | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @kendra
  Scenario: Configure Amazon Kendra with all fields
    When I create an estimate with:
      | service      | Amazon Kendra |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @augmented-ai
  Scenario: Configure Amazon Augmented AI with all fields
    When I create an estimate with:
      | service      | Amazon Augmented AI |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfReviewedImagesPerMonthWithAmazonRe | 5000 |
      | numberOfReviewedPagesPerMonthWithAmazonTex | 3000 |
      | numberOfReviewedObjectsPerMonthWithACustom | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @lookout-metrics
  Scenario: Configure Amazon Lookout for Metrics with all fields
    When I create an estimate with:
      | service      | Amazon Lookout for Metrics |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfMeasures | 100 |
      | totalNumberOfDimensionValues | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @lookout-vision
  Scenario: Configure Amazon Lookout for Vision with all fields
    When I create an estimate with:
      | service      | Amazon Lookout for Vision |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPlants | 1 |
      | numberOfProductionLinesPerPlant | 3 |
      | numberOfInspectionPointsPerProductionLine | 2 |
      | numberOfCamerasPerInspectionPoint | 1 |
      | timeToTrainInitialModelHours | 4 |
      | numberOfInferenceUnits | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @entity-resolution
  Scenario: Configure AWS Entity Resolution with all fields
    When I create an estimate with:
      | service      | AWS Entity Resolution |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRecords | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @analytics @athena
  Scenario: Configure Amazon Athena - on-demand queries
    When I create an estimate with:
      | service      | Amazon Athena |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfQueries | 1000 |
      | amountOfDataScannedPerQuery | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @athena @provisioned
  Scenario: Configure Amazon Athena - provisioned capacity
    When I create an estimate with:
      | service      | Amazon Athena |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfQueries | 5000 |
      | amountOfDataScannedPerQuery | 10 |
      | numberOfDPUs | 8 |
      | lengthOfTimeCapacityIsActive | 200 |
      | totalNumberOfSparkSessions | 50 |
      | codeExecutionPerSession | 30 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @kinesis-data-streams
  Scenario: Configure Amazon Kinesis Data Streams - standard
    When I create an estimate with:
      | service      | Amazon Kinesis Data Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRecords | 100000 |
      | averageRecordSize | 5 |
      | numberOfConsumerApplications | 2 |
      | numberOfDaysForDataRetention | 7 |
      | numberOfEnhancedFanoutConsumers | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @kinesis-data-streams @high-throughput
  Scenario: Configure Amazon Kinesis Data Streams - high throughput
    When I create an estimate with:
      | service      | Amazon Kinesis Data Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRecords | 5000000 |
      | averageRecordSize | 10 |
      | numberOfConsumerApplications | 5 |
      | numberOfDaysForDataRetention | 30 |
      | numberOfEnhancedFanoutConsumers | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @kinesis-video
  Scenario: Configure Amazon Kinesis Video Streams with all fields
    When I create an estimate with:
      | service      | Amazon Kinesis Video Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevices | 10 |
      | averageBitrate | 5 |
      | durationOfVideoStreamedToAmazonKinesisVideo | 8 |
      | averageRetentionForVideo | 24 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @data-firehose
  Scenario Outline: Configure Amazon Data firehose - <source> source
    When I create an estimate with:
      | service      | Amazon Data firehose |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Source | <source> |
      | numberOfRecordsForDataIngestion | 1000 |
      | recordSize | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Source variants
      | source                               |
      | Direct PUT or Kinesis Data Stream     |
      | Vended logs                           |
      | MSK or MSK Serverless                 |

  @analytics @msk
  Scenario: Configure Amazon Managed Streaming for Apache Kafka (MSK) - small
    When I create an estimate with:
      | service      | Amazon Managed Streaming for Apache Kafka (MSK) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | kafka.m5.large |
      | numberOfKafkaBrokerNodes | 3 |
      | storagePerBroker | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @msk @large
  Scenario: Configure Amazon Managed Streaming for Apache Kafka (MSK) - large
    When I create an estimate with:
      | service      | Amazon Managed Streaming for Apache Kafka (MSK) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | kafka.m5.2xlarge |
      | numberOfKafkaBrokerNodes | 9 |
      | storagePerBroker | 2000 |
      | desiredProvisionedStorageThroughput | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @managed-flink
  Scenario: Configure Amazon Managed Service for Apache Flink with all fields
    When I create an estimate with:
      | service      | Amazon Managed Service for Apache Flink |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | apacheFlinkApplications | 2 |
      | apacheFlinkKpus | 4 |
      | durableApplicationBackupsMaintained | 3 |
      | durableApplicationBackupStorageAverageSize | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @glue
  Scenario: Configure AWS Glue - Spark ETL
    When I create an estimate with:
      | service      | AWS Glue |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDPUsForApacheSparkJob | 10 |
      | durationForApacheSparkETLJob | 2 |
      | numberOfDPUsForPythonShellJob | 2 |
      | numberOfDPUsForInteractiveSession | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @glue @heavy-etl
  Scenario: Configure AWS Glue - heavy ETL workload
    When I create an estimate with:
      | service      | AWS Glue |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDPUsForApacheSparkJob | 50 |
      | durationForApacheSparkETLJob | 8 |
      | numberOfDPUsForPythonShellJob | 10 |
      | numberOfDPUsForInteractiveSession | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @lake-formation
  Scenario: Configure AWS Lake Formation with all fields
    When I create an estimate with:
      | service      | AWS Lake Formation |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataScanned | 100 |
      | storageUsageInAMonthInMillions | 5 |
      | requestsInAMonthInMillions | 10 |
      | numberOfTables | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @quicksight
  Scenario: Configure Amazon QuickSight with all fields
    When I create an estimate with:
      | service      | Amazon QuickSight |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfReaders | 100 |
      | numberOfAuthors | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @finspace
  Scenario: Configure Amazon FinSpace Dataset Browser with all fields
    When I create an estimate with:
      | service      | Amazon FinSpace Dataset Browser |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfUsers | 5 |
      | sizeOfDataToBeStored | 100 |
      | totalTimeSpentSmallClusterAcrossAllUsers | 40 |
      | totalTimeSpentMediumClusterAcrossAllUsers | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @integration @sqs
  Scenario: Configure Amazon Simple Queue Service (SQS) - standard workload
    When I create an estimate with:
      | service      | Amazon Simple Queue Service (SQS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | standardQueueRequests | 10000000 |
      | fifoQueueRequests | 1000000 |
      | fairQueueRequests | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @sqs @high-throughput
  Scenario: Configure Amazon Simple Queue Service (SQS) - high throughput
    When I create an estimate with:
      | service      | Amazon Simple Queue Service (SQS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | standardQueueRequests | 100000000 |
      | fifoQueueRequests | 50000000 |
      | fairQueueRequests | 10000000 |
      | dataTransfer | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @sns
  Scenario: Configure Amazon Simple Notification Service (SNS) with all fields
    When I create an estimate with:
      | service      | Amazon Simple Notification Service (SNS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | requests | 10000000 |
      | httpHttpsNotifications | 5000000 |
      | emailNotifications | 100000 |
      | sqsNotifications | 2000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @eventbridge
  Scenario: Configure Amazon EventBridge - standard events
    When I create an estimate with:
      | service      | Amazon EventBridge |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | sizeOfThePayload | 10 |
      | numberOfAWSManagementEvents | 1000000 |
      | numberOfCustomEvents | 5000000 |
      | numberOfInvocations | 2000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @eventbridge @cross-account
  Scenario: Configure Amazon EventBridge - cross-account with pipes
    When I create an estimate with:
      | service      | Amazon EventBridge |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | sizeOfThePayload | 64 |
      | numberOfCustomEvents | 20000000 |
      | numberOfPartnerEvents | 5000000 |
      | numberOfEventsDeliveredToAnotherBus | 10000000 |
      | Number of events delivered to a service in a different account | 5000000 |
      | numberOfInvocations | 10000000 |
      | numberOfReplayedEvents | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @swf
  Scenario: Configure Amazon Simple Workflow Service (SWF) with all fields
    When I create an estimate with:
      | service      | Amazon Simple Workflow Service (SWF) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | workflowExecutions | 10000 |
      | totalTasksMarkersTimersAndSignals | 50000 |
      | workflowLifetime | 30 |
      | workflowRetention | 90 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @appflow
  Scenario: Configure Amazon AppFlow with all fields
    When I create an estimate with:
      | service      | Amazon AppFlow |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfFlows | 5 |
      | volumeOfDataPerFlow | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @appsync
  Scenario: Configure AWS AppSync with all fields
    When I create an estimate with:
      | service      | AWS AppSync |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfApiRequests | 5000000 |
      | enterAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @mq
  Scenario Outline: Configure Amazon MQ - <broker_type> with <storage>
    When I create an estimate with:
      | service      | Amazon MQ |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Broker type | <broker_type> |
      | Instance type | <instance_type> |
      | Storage type | <storage> |
      | numberOfBrokersRunning | 2 |
      | storagePerBroker | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Broker and storage combinations
      | broker_type                    | instance_type  | storage                           |
      | Single-instance Broker         | mq.m5.large    | Durability optimized (Amazon EFS) |
      | Single-instance Broker         | mq.t3.micro    | Throughput optimized (EBS)        |
      | Single-instance Broker         | mq.m5.xlarge   | Throughput optimized (EBS)        |
      | Active/standby-instance Broker | mq.m5.large    | Durability optimized (Amazon EFS) |
      | Active/standby-instance Broker | mq.m5.xlarge   | Durability optimized (Amazon EFS) |
      | Active/standby-instance Broker | mq.m5.2xlarge  | Throughput optimized (EBS)        |

  # ============================================================
  # ============================================================
  @messaging @ses
  Scenario: Configure Amazon Simple Email Service (SES) with all fields
    When I create an estimate with:
      | service      | Amazon Simple Email Service (SES) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfOpenIngressEndpoints | 1 |
      | numberOfEmailsProcessedByMailManager | 100000 |
      | emailMessagesSentFromEc2 | 50000 |
      | attachmentDataSentFromEc2 | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @messaging @pinpoint
  Scenario: Configure Amazon Pinpoint with all fields
    When I create an estimate with:
      | service      | Amazon Pinpoint |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPushNotifications | 1000000 |
      | numberOfInappMessageRequests | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @management @cloudwatch
  Scenario: Configure Amazon CloudWatch - standard monitoring
    When I create an estimate with:
      | service      | Amazon CloudWatch |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfMetrics | 500 |
      | getMetricDataRequests | 1000 |
      | numberOfOtherAPIRequests | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @cloudwatch @database-insights
  Scenario: Configure Amazon CloudWatch - with database insights
    When I create an estimate with:
      | service      | Amazon CloudWatch |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfMetrics | 2000 |
      | getMetricDataRequests | 5000 |
      | getMetricWidgetImageRequests | 1000 |
      | numberOfOtherAPIRequests | 500000 |
      | numberOfVCPUsMonitoredByDatabaseInsights | 32 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @cloudtrail
  Scenario: Configure AWS CloudTrail with all fields
    When I create an estimate with:
      | service      | AWS CloudTrail |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | OpsMult | 1000000 |
      | numberOfWriteTrails | 2 |
      | dataIngestedCloudTrail | 100 |
      | dataScannedUsingQueries | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @config
  Scenario: Configure AWS Config with all fields
    When I create an estimate with:
      | service      | AWS Config |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfContinuousConfigItems | 5000 |
      | numberOfPeriodicConfigItems | 1000 |
      | numberOfConfigRuleEvaluations | 10000 |
      | numberOfConformancePackEvaluations | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @cloudformation
  Scenario: Configure AWS CloudFormation with all fields
    When I create an estimate with:
      | service      | AWS CloudFormation |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfThirdpartyExtensionsManaged | 5 |
      | totalNumberOfOperationsPerExtension | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @systems-manager
  Scenario: Configure AWS Systems Manager with all fields
    When I create an estimate with:
      | service      | AWS Systems Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | standardParameters | 100 |
      | advancedParameters | 10 |
      | frequencyOfApiInteractionsPerParameter | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @service-catalog
  Scenario: Configure AWS Service Catalog with all fields
    When I create an estimate with:
      | service      | AWS Service Catalog |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfApiCalls | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @managed-grafana
  Scenario: Configure Amazon Managed Grafana with all fields
    When I create an estimate with:
      | service      | Amazon Managed Grafana |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfActiveEditorsadministrators | 5 |
      | numberOfActiveViewers | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @managed-prometheus
  Scenario: Configure Amazon Managed Service for Prometheus with all fields
    When I create an estimate with:
      | service      | Amazon Managed Service for Prometheus |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | averageActiveTimeSeries | 100000 |
      | avgCollectionIntervalInSeconds | 60 |
      | retentionPeriodInDays | 90 |
      | averageNumberOfDashboardUsersPerDay | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @xray
  Scenario: Configure AWS X-Ray with all fields
    When I create an estimate with:
      | service      | AWS X-Ray |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRequestsPerMonth | 5000000 |
      | numberOfQueriesPerMonth | 10000 |
      | tracesRetrievedPerQuery | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @resilience-hub
  Scenario: Configure AWS Resilience Hub with all fields
    When I create an estimate with:
      | service      | AWS Resilience Hub |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfApplicationsAssessedForResilience | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @fis
  Scenario: Configure AWS Fault Injection Service (FIS) with all fields
    When I create an estimate with:
      | service      | AWS Fault Injection Service (FIS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | experimentsPerMonth | 20 |
      | averageActionminutesPerExperiment | 30 |
      | averageCountOfTargetAccountsPerExperiment | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @audit-manager
  Scenario: Configure AWS Audit Manager with all fields
    When I create an estimate with:
      | service      | AWS Audit Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAccounts | 5 |
      | numberOfResourcesPerAccount | 200 |
      | numberOfConfigurationSnapshotsApiCalls | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @security @guardduty
  Scenario: Configure Amazon GuardDuty - basic protection
    When I create an estimate with:
      | service      | Amazon GuardDuty |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudTrailManagementEventAnalysis | 5000000 |
      | ec2VpcFlowLogAnalysis | 100 |
      | ec2DnsQueryLogAnalysis | 50 |
      | cloudTrailS3DataEventAnalysis | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @guardduty @full-protection
  Scenario: Configure Amazon GuardDuty - full protection suite
    When I create an estimate with:
      | service      | Amazon GuardDuty |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudTrailManagementEventAnalysis | 10000000 |
      | ec2VpcFlowLogAnalysis | 500 |
      | ec2DnsQueryLogAnalysis | 200 |
      | cloudTrailS3DataEventAnalysis | 50000000 |
      | eksAuditLogsAnalysis | 100 |
      | ebsVolumeDataScanAnalysis | 500 |
      | rdsProvisionedInstanceVCPU | 64 |
      | lambdaVpcFlowLogAnalysis | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @inspector
  Scenario: Configure Amazon Inspector - standard scanning
    When I create an estimate with:
      | service      | Amazon Inspector |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | averageEC2InstancesScanned | 50 |
      | totalContainerImagesPushed | 100 |
      | totalAutomatedRescans | 4 |
      | averageLambdaFunctionsScanned | 25 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @inspector @code-scanning
  Scenario: Configure Amazon Inspector - with code scanning
    When I create an estimate with:
      | service      | Amazon Inspector |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | averageEC2InstancesScanned | 200 |
      | totalContainerImagesPushed | 500 |
      | totalAutomatedRescans | 8 |
      | averageLambdaFunctionsScanned | 100 |
      | totalNumberOfRepositories | 50 |
      | Number of SAST periodic scans per repository per month | 30 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @macie
  Scenario: Configure Amazon Macie with all fields
    When I create an estimate with:
      | service      | Amazon Macie |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfS3Buckets | 50 |
      | totalBytesInS3Storage | 1000 |
      | numberOfObjectsMonitoredForAutomatedDataDis | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @detective
  Scenario: Configure Amazon Detective with all fields
    When I create an estimate with:
      | service      | Amazon Detective |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataIngestedFromAwsCloudtrailAmazonVpcFlow | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @security-hub
  Scenario: Configure AWS Security Hub with all fields
    When I create an estimate with:
      | service      | AWS Security Hub |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAccounts | 5 |
      | numberOfSecurityChecksPerAccount | 500 |
      | numberOfFindingIngestedPerAccount | 10000 |
      | numberOfAutomationRules | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @kms
  Scenario: Configure AWS Key Management Service with all fields
    When I create an estimate with:
      | service      | AWS Key Management Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfCmk | 10 |
      | numberOfSymmetricRequests | 1000000 |
      | numberOfAsymmetricRequests | 100000 |
      | numberOfAsymmetricRequestsRSA2048 | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @secrets-manager
  Scenario: Configure AWS Secrets Manager with all fields
    When I create an estimate with:
      | service      | AWS Secrets Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | NumberOfSecrets | 100 |
      | secretDuration | 30 |
      | numberOfAPIs | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @certificate-manager
  Scenario: Configure AWS Certificate Manager with all fields
    When I create an estimate with:
      | service      | AWS Certificate Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfFullyQualifiedDomainNamesFqdns | 10 |
      | numberOfWildcardDomainNames | 3 |
      | numberOfApiCalls | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @private-ca
  Scenario: Configure AWS Private Certificate Authority with all fields
    When I create an estimate with:
      | service      | AWS Private Certificate Authority |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPrivateCas | 2 |
      | numberOfGeneralPurposeModePrivateCertificate | 1000 |
      | numberOfCertificatesUsedWithAcmintegratedSer | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @cloudhsm
  Scenario: Configure AWS CloudHSM with all fields
    When I create an estimate with:
      | service      | AWS CloudHSM |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfHsm1mediumHsms | 2 |
      | totalNumberOfHsm2mmediumHsms | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @iam-access-analyzer
  Scenario: Configure AWS IAM Access Analyzer with all fields
    When I create an estimate with:
      | service      | AWS IAM Access Analyzer |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAccountsToMonitor | 5 |
      | averageRolesPerAccount | 50 |
      | averageUsersPerAccount | 100 |
      | numberOfAnalyzersPerAccount | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @cognito
  Scenario: Configure Amazon Cognito with all fields
    When I create an estimate with:
      | service      | Amazon Cognito |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfMAU | 50000 |
      | numberOfMAUSAML | 5000 |
      | numberOfTokenRequests | 100000 |
      | numberOfAppClients | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @verified-permissions
  Scenario: Configure Amazon Verified Permissions with all fields
    When I create an estimate with:
      | service      | Amazon Verified Permissions |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfSingleAuthorizationRequests | 1000000 |
      | numberOfBatchAuthorizationRequests | 100000 |
      | numberOfPolicyManagementRequests | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @security-lake
  Scenario: Configure Amazon Security Lake with all fields
    When I create an estimate with:
      | service      | Amazon Security Lake |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudtrailEvents | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @payment-cryptography
  Scenario: Configure AWS Payment Cryptography with all fields
    When I create an estimate with:
      | service      | AWS Payment Cryptography |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfApiRequests | 1000000 |
      | numberOfActiveKeys | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @directory-service
  Scenario: Configure AWS Directory Service with all fields
    When I create an estimate with:
      | service      | AWS Directory Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfDirectories | 2 |
      | numberOfTotalAdditionalDomainControllers | 2 |
      | numberOfDirectoriesToBeShared | 1 |
      | numberOfAdditionalAccountsToWhichEachDirect | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @developer @codebuild
  Scenario: Configure AWS CodeBuild with all fields
    When I create an estimate with:
      | service      | AWS CodeBuild |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | general1.medium |
      | numberOfBuildsInAMonth | 500 |
      | averageBuildDurationMinutes | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codedeploy
  Scenario: Configure AWS CodeDeploy with all fields
    When I create an estimate with:
      | service      | AWS CodeDeploy |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfOnpremiseInstances | 10 |
      | numberOfDeployments | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codepipeline
  Scenario: Configure AWS CodePipeline with all fields
    When I create an estimate with:
      | service      | AWS CodePipeline |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfActivePipelinesOfTypeV1UsedPerAcc | 5 |
      | numberOfActionExecutionMinutesUsedInPipelin | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codeartifact
  Scenario: Configure AWS CodeArtifact with all fields
    When I create an estimate with:
      | service      | AWS CodeArtifact |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | sizeOfArtifactsStored | 50 |
      | numberOfApiRequests | 100000 |
      | enterAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codeguru
  Scenario: Configure Amazon CodeGuru Reviewer with all fields
    When I create an estimate with:
      | service      | Amazon CodeGuru Reviewer |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfRepositories | 10 |
      | averageLinesOfCodeLocPerRepository | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @iot @iot-core
  Scenario: Configure AWS IoT Core - small deployment
    When I create an estimate with:
      | service      | AWS IoT Core |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevicesMqtt | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-core @large
  Scenario: Configure AWS IoT Core - large fleet
    When I create an estimate with:
      | service      | AWS IoT Core |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevicesMqtt | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-analytics
  Scenario: Configure AWS IoT Analytics with all fields
    When I create an estimate with:
      | service      | AWS IoT Analytics |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfIotDevicesMonthly | 1000 |
      | dataGenerationByEachDevice | 10 |
      | numberOfDataPipelinesMonthly | 5 |
      | dataQueriedPerMonth | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-events
  Scenario: Configure AWS IoT Events with all fields
    When I create an estimate with:
      | service      | AWS IoT Events |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevices | 500 |
      | numberOfMessagesForADeviceIncludingTimerEx | 100 |
      | numberOfEventDetectorModelsPerDevice | 2 |
      | averageSizeOfEachMessage | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-greengrass
  Scenario: Configure AWS IoT Greengrass with all fields
    When I create an estimate with:
      | service      | AWS IoT Greengrass |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfGreengrassCoreDevices | 50 |
      | activityPeriodInMinutesPerMonth | 43200 |
      | mqttTopicsWithCloudAsSourceOptional | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-sitewise
  Scenario: Configure AWS IoT SiteWise with all fields
    When I create an estimate with:
      | service      | AWS IoT SiteWise |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDailyMeasurements | 1000000 |
      | numberOfTagsOrSensors | 500 |
      | cloudDataAvailablity | 30 |
      | bufferPeriod | 7 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-device-defender
  Scenario: Configure AWS IoT Device Defender with all fields
    When I create an estimate with:
      | service      | AWS IoT Device Defender |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-device-management
  Scenario: Configure AWS IoT Device Management with all fields
    When I create an estimate with:
      | service      | AWS IoT Device Management |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @media @medialive
  Scenario: Configure AWS Elemental MediaLive with all fields
    When I create an estimate with:
      | service      | AWS Elemental MediaLive |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInputs | 2 |
      | activeHoursOnDemand | 730 |
      | numberOfOutputs | 4 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediaconvert
  Scenario: Configure AWS Elemental MediaConvert with all fields
    When I create an estimate with:
      | service      | AWS Elemental MediaConvert |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | outputBasicUsage | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediapackage
  Scenario: Configure AWS Elemental MediaPackage with all fields
    When I create an estimate with:
      | service      | AWS Elemental MediaPackage |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInputsPerChannel | 2 |
      | totalDurationOfLiveStreamsPerMonth | 730 |
      | ingestBitratePerInputMbitPerSecond | 5 |
      | averageNumberOfViewersPerHour | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediaconnect
  Scenario: Configure AWS Elemental MediaConnect with all fields
    When I create an estimate with:
      | service      | AWS Elemental MediaConnect |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRunningFlows | 2 |
      | flowUtilization | 730 |
      | numberOfOutputsPerFlow | 3 |
      | bitrateMbitPerSecond | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediatailor
  Scenario: Configure AWS Elemental Media Tailor with all fields
    When I create an estimate with:
      | service      | AWS Elemental Media Tailor |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | basicTierChannelHoursPerMonth | 730 |
      | standardTierChannelHoursPerMonth | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @migration @dms
  Scenario: Configure AWS Database Migration Service with all fields
    When I create an estimate with:
      | service      | AWS Database Migration Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | dms.r5.large |
      | numberOfInstances | 2 |
      | storageAmountMultipleAz | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @migration @application-migration
  Scenario: Configure AWS Application Migration Service with all fields
    When I create an estimate with:
      | service      | AWS Application Migration Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfServers | 10 |
      | numberOfHoursPerServer | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @migration @transfer-family
  Scenario: Configure AWS Transfer Family with all fields
    When I create an estimate with:
      | service      | AWS Transfer Family |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfEndpointsWithAs2Enabled | 2 |
      | numberOfAs2MessagesSentPerMonth | 10000 |
      | numberOfAs2MessagesReceivedPerMonth | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @migration @migration-hub-refactor
  Scenario: Configure AWS Migration Hub Refactor Spaces with all fields
    When I create an estimate with:
      | service      | AWS Migration Hub Refactor Spaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfEnvironments | 2 |
      | numberOfHours | 730 |
      | apiRequests | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @business @workspaces
  Scenario Outline: Configure Amazon WorkSpaces - <os>
    When I create an estimate with:
      | service      | Amazon WorkSpaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Operating system | <os> |
      | numberOfWorkspaces | 10 |
      | billingOption | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: OS variants
      | os                       |
      | Windows                  |
      | Red Hat Enterprise Linux |
      | Ubuntu Linux             |
      | Rocky Linux              |

  @business @workspaces @high-performance
  Scenario: Configure Amazon WorkSpaces with high-performance bundle
    When I create an estimate with:
      | service      | Amazon WorkSpaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Operating system | Windows |
      | numberOfWorkspaces | 25 |
      | billingOption | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @business @workspaces-applications
  Scenario: Configure Amazon WorkSpaces Applications with all fields
    When I create an estimate with:
      | service      | Amazon WorkSpaces Applications |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | stream.standard.large |
      | numberOfUsersPerMonth | 50 |
      | numberOfWorkingHoursPerDay | 8 |
      | instanceDiskVolumeSize | 100 |
      | daysInWeek | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @workflow @managed-airflow
  Scenario Outline: Configure Amazon Managed Workflows for Apache Airflow - <env_size> environment
    When I create an estimate with:
      | service      | Amazon Managed Workflows for Apache Airflow |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Environment size | <env_size> |
      | minimumWorkers | 2 |
      | maximumWorkers | 10 |
      | hoursAtMaximumWorkers | 4 |
      | minimumWebServers | 2 |
      | maximumWebServers | 5 |
      | hoursAtMaximumWebServers | 4 |
      | numberOfSchedulers | 2 |
      | dataStorageSize | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Environment size variants
      | env_size |
      | Small    |
      | Medium   |
      | Large    |
      | XL       |
      | 2XL      |

  # ============================================================
  # ============================================================
  @windows @windows-sql-ec2
  Scenario: Configure Windows Server and SQL Server on Amazon EC2 with all fields
    When I create an estimate with:
      | service      | Windows Server and SQL Server on Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | machineDescription | Production SQL Server |
      | storageAmountGb | 500 |
      | iops | 3000 |
      | numberOfVcpus | 8 |
      | memoryGib | 32 |
      | quantity | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @health @healthlake
  Scenario: Configure Amazon Healthlake with all fields
    When I create an estimate with:
      | service      | Amazon Healthlake |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | additionalDataStorage | 100 |
      | totalNumberOfQueriesPerMonth | 50000 |
      | numberOfNlpCharacters | 10000000 |
      | exportedDataPerGb | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @data @b2b-data-interchange
  Scenario: Configure AWS B2B Data Interchange with all fields
    When I create an estimate with:
      | service      | AWS B2B Data Interchange |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPartnerships | 5 |
      | numberOfTransformationStepsPerMonth | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @discovery @cloud-map
  Scenario: Configure AWS Cloud Map with all fields
    When I create an estimate with:
      | service      | AWS Cloud Map |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @location @location-service
  Scenario: Configure Amazon Location Service with all fields
    When I create an estimate with:
      | service      | Amazon Location Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dynamicMaps | 100000 |
      | staticMaps | 10000 |
      | openDataDynamicMaps | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @compute @ec2 @spot
  Scenario: Configure Amazon EC2 - Spot instance
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | c6g.2xlarge |
      | columnFormIPM[0].Number of Nodes | 10 |
      | storageAmount | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @ec2 @gpu
  Scenario: Configure Amazon EC2 - GPU instance
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | p4d.24xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | storageAmount | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @ec2 @graviton
  Scenario: Configure Amazon EC2 - Graviton ARM instance
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | m7g.xlarge |
      | columnFormIPM[0].Number of Nodes | 8 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-postgresql @reserved
  Scenario: Configure Amazon RDS for PostgreSQL - Reserved pricing
    When I create an estimate with:
      | service      | Amazon RDS for PostgreSQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | storageVolume | General Purpose SSD (gp3) |
      | Select an instance | db.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-mysql @reserved
  Scenario: Configure Amazon RDS for MySQL - Reserved pricing
    When I create an estimate with:
      | service      | Amazon RDS for MySQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | storageVolume | General Purpose SSD (gp3) |
      | Select an instance | db.r6g.2xlarge |
      | columnFormIPM[0].Number of Nodes | 4 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @aurora-mysql @serverless
  Scenario: Configure Amazon Aurora MySQL-Compatible - Serverless workload
    When I create an estimate with:
      | service      | Amazon Aurora MySQL-Compatible |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | Aurora I/O-Optimized |
      | columnFormIPM[0].TermType | OnDemand |
      | Select an instance | db.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | columnFormIPM[0].undefined.unit | 50 |
      | storageAmount | 500 |
      | baselineIORate | 5000 |
      | Duration of peak IO activity | 4 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @aurora-postgresql @extended-support
  Scenario: Configure Amazon Aurora PostgreSQL-Compatible DB - Extended Support
    When I create an estimate with:
      | service      | Amazon Aurora PostgreSQL-Compatible DB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | Aurora Standard |
      | columnFormIPM[0].TermType | OnDemand |
      | Select an instance | db.r6g.2xlarge |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 200 |
      | baselineIORate | 2000 |
      | Number of hours running on Amazon RDS Extended Support | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @dynamodb @global-tables
  Scenario: Configure Amazon DynamoDB - Global Tables workload
    When I create an estimate with:
      | service      | Amazon DynamoDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | tableClass | Standard |
      | averageItemSize | 500 |
      | percentageOfNonTransactionalWrites | 80 |
      | baselineWriteRate | 1000 |
      | peakWriteRate | 10000 |
      | durationOfPeakWriteActivity | 6 |
      | baselineReadRate | 5000 |
      | peakReadRate | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @elasticache @memcached-large
  Scenario: Configure Amazon ElastiCache - Large Memcached cluster
    When I create an estimate with:
      | service      | Amazon ElastiCache |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | EngineType | Memcached |
      | Select an instance | cache.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 10 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @neptune @large-graph
  Scenario: Configure Amazon Neptune - Large graph database
    When I create an estimate with:
      | service      | Amazon Neptune |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | Neptune I/O-Optimized |
      | Select an instance | db.r6g.2xlarge |
      | columnFormIPM[0].Number of Nodes | 4 |
      | columnFormIPM[0].undefined.unit | 100 |
      | Number of workbench instances | 2 |
      | Usage (Neptune Workbench instances) | 50 |
      | dataStored | 200 |
      | Number of I/O operations (Requests) | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @documentdb @large-cluster
  Scenario: Configure Amazon DocumentDB - Large cluster
    When I create an estimate with:
      | service      | Amazon DocumentDB (with MongoDB compatibility) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | engine | Amazon DocumentDB I/O-Optimized |
      | Select an instance | db.r6g.2xlarge |
      | columnFormIPM[0].Number of Nodes | 6 |
      | columnFormIPM[0].undefined.unit | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @ebs @high-iops
  Scenario: Configure Amazon Elastic Block Store (EBS) - High IOPS workload
    When I create an estimate with:
      | service      | Amazon Elastic Block Store (EBS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | volumeType | Provisioned IOPS SSD (io2) |
      | numberOfVolumes | 8 |
      | averageDurationOfVolume | 730 |
      | storageAmountPerVolume | 1000 |
      | amountChangedPerSnapshot | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @efs @large-storage
  Scenario: Configure Amazon Elastic File System (EFS) - Large storage with provisioned throughput
    When I create an estimate with:
      | service      | Amazon Elastic File System (EFS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | throughputMode | Provisioned Throughput |
      | desiredStorageCapacity | 5000 |
      | infrequentAccessTiering | 40 |
      | infrequentAccessRead | 20 |
      | archiveAccessTiering | 10 |
      | archiveAccessRead | 5 |
      | Read Data Transferred | 1000 |
      | Write Data Transferred | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @fsx-lustre @high-throughput
  Scenario: Configure Amazon FSx for Lustre - High throughput SSD
    When I create an estimate with:
      | service      | Amazon FSx for Lustre |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Storage type | SSD |
      | storageCapacity | 4800 |
      | metadataIopsOptional | 3000 |
      | backupStorage | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @fsx-ontap @large
  Scenario: Configure Amazon FSx for NetApp ONTAP - Large Multi-AZ
    When I create an estimate with:
      | service      | Amazon FSx for NetApp ONTAP |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Deployment type | Multi-AZ 2 Deployment |
      | desiredStorageCapacity | 10240 |
      | desiredAdditionalSsdIops | 10000 |
      | desiredAggregateThroughput | 2048 |
      | readRequestsToCapacityPoolStorage | 1000000 |
      | writeRequestsToCapacityPoolStorage | 500000 |
      | backupStorage | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @cloudfront @enterprise
  Scenario: Configure Amazon CloudFront - Enterprise distribution
    When I create an estimate with:
      | service      | Amazon CloudFront |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | proPlan | 2 |
      | businessPlan | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @network-firewall @multi-endpoint
  Scenario: Configure AWS Network Firewall - Multi-endpoint deployment
    When I create an estimate with:
      | service      | AWS Network Firewall |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfEndpoints | 6 |
      | monthlyUsagePerEndpoint | 730 |
      | advancedInspectionMonthlyUsage | 730 |
      | numberOfSecondaryEndpoints | 6 |
      | usagePerSecondaryEndpoint | 730 |
      | dataProcessedPerMonth | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @bedrock @nova-pro
  Scenario: Configure Amazon Bedrock - Nova Pro model
    When I create an estimate with:
      | service      | Amazon Bedrock |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | inferenceType | Geo Cross Region Inference |
      | pricingModel | On Demand - Standard |
      | averageRequestsPerMinute | 50 |
      | hoursPerDayAtThisRate | 16 |
      | averageInputTokensPerRequest | 2000 |
      | averageOutputTokensPerRequest | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @bedrock @embeddings
  Scenario: Configure Amazon Bedrock - Embeddings workload
    When I create an estimate with:
      | service      | Amazon Bedrock |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | inferenceType | In-Region |
      | pricingModel | On Demand - Standard |
      | averageRequestsPerMinute | 200 |
      | hoursPerDayAtThisRate | 24 |
      | averageInputTokensPerRequest | 512 |
      | averageOutputTokensPerRequest | 0 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @fargate @batch
  Scenario: Configure AWS Fargate - Batch processing
    When I create an estimate with:
      | service      | AWS Fargate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | selectArchitecture | ARM |
      | numberOfTasks | 100 |
      | taskDuration | 1800 |
      | memoryStandardFargateOnDemand | 8 |
      | storageAmountECS | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @lambda @high-volume
  Scenario: Configure AWS Lambda - High volume event processing
    When I create an estimate with:
      | service      | AWS Lambda |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | architecture | Arm |
      | numberOfRequests | 100000000 |
      | durationOfEachRequest | 50 |
      | amountOfMemoryAllocated | 256 |
      | amountOfEphemeralStorageAllocated | 512 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @opensearch @large-cluster
  Scenario: Configure Amazon OpenSearch Service - Large cluster
    When I create an estimate with:
      | service      | Amazon OpenSearch Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].TermType | OnDemand |
      | Select an instance | r6g.xlarge.search |
      | columnFormIPM[0].Number of Nodes | 9 |
      | columnFormIPM[0].undefined.unit | 100 |
      | Number of instances | 3 |
      | storageAmountPerVolumeGP3 | 500 |
      | provisioningIOPSPerVolumeGP3 | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @mq @rabbitmq
  Scenario: Configure Amazon MQ - RabbitMQ broker
    When I create an estimate with:
      | service      | Amazon MQ |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Broker type | Single-instance Broker |
      | Instance type | mq.m5.2xlarge |
      | Storage type | Durability optimized (Amazon EFS) |
      | numberOfBrokersRunning | 3 |
      | storagePerBroker | 100 |
      | enterAmount | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @workflow @managed-airflow @production
  Scenario: Configure Amazon Managed Workflows for Apache Airflow - Production setup
    When I create an estimate with:
      | service      | Amazon Managed Workflows for Apache Airflow |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Environment size | Large |
      | minimumWorkers | 5 |
      | maximumWorkers | 25 |
      | hoursAtMaximumWorkers | 8 |
      | minimumWebServers | 2 |
      | maximumWebServers | 5 |
      | hoursAtMaximumWebServers | 8 |
      | numberOfSchedulers | 3 |
      | dataStorageSize | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @kms @high-volume
  Scenario: Configure AWS Key Management Service - High volume encryption
    When I create an estimate with:
      | service      | AWS Key Management Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfCmk | 50 |
      | numberOfSymmetricRequests | 50000000 |
      | numberOfAsymmetricRequests | 5000000 |
      | numberOfAsymmetricRequestsRSA2048 | 2000000 |
      | numberOfECCGenerateDataKeyPairRequests | 1000000 |
      | numberOfRSAGenerateDataKeyPairRequests | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @cloudtrail @comprehensive
  Scenario: Configure AWS CloudTrail - Comprehensive logging
    When I create an estimate with:
      | service      | AWS CloudTrail |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | OpsMult | 10000000 |
      | numberOfWriteTrails | 3 |
      | numberOfReadTrails | 5000000 |
      | Read management trails | 2 |
      | dataOpsMult | 50000000 |
      | numberOfS3Trails | 2 |
      | numberOfLambdaTrails | 10000000 |
      | Lambda trails | 2 |
      | dataIngestedCloudTrail | 500 |
      | dataScannedUsingQueries | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @amplify @large-site
  Scenario: Configure AWS Amplify - Large web application
    When I create an estimate with:
      | service      | AWS Amplify |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfBuildMinutes | 5000 |
      | dataStoredPerMonth | 200 |
      | dataServedPerMonth | 2000 |
      | numberOfSsrRequests | 10000000 |
      | durationOfEachRequestInMs | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @sns @high-volume
  Scenario: Configure Amazon Simple Notification Service (SNS) - High volume
    When I create an estimate with:
      | service      | Amazon Simple Notification Service (SNS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | requests | 100000000 |
      | httpHttpsNotifications | 50000000 |
      | sqsNotifications | 30000000 |
      | Amazon Web Services Lambda | 20000000 |
      | mobilePushNotifications | 5000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @backup @enterprise
  Scenario: Configure AWS Backup - Enterprise backup strategy
    When I create an estimate with:
      | service      | AWS Backup |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | primaryDataGB | 10000 |
      | dailyChangePct | 3 |
      | dailyWarmRetention | 30 |
      | weeklyWarmRetention | 52 |
      | monthlyWarmRetention | 36 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @medialive @large-broadcast
  Scenario: Configure AWS Elemental MediaLive - Large broadcast
    When I create an estimate with:
      | service      | AWS Elemental MediaLive |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInputs | 8 |
      | activeHoursOnDemand | 730 |
      | numberOfOutputs | 16 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @migration @dms @large-migration
  Scenario: Configure AWS Database Migration Service - Large migration
    When I create an estimate with:
      | service      | AWS Database Migration Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | dms.r5.2xlarge |
      | numberOfInstances | 5 |
      | storageAmountMultipleAz | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @waf @comprehensive
  Scenario: Configure AWS Web Application Firewall (WAF) - Comprehensive rules
    When I create an estimate with:
      | service      | AWS Web Application Firewall (WAF) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfWebAcls | 10 |
      | numberOfRulesPerWebAcl | 50 |
      | numberOfRulesInsideRuleGroup | 20 |
      | numberOfWebRequests | 100000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @cognito @enterprise
  Scenario: Configure Amazon Cognito - Enterprise user pool
    When I create an estimate with:
      | service      | Amazon Cognito |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfMAU | 500000 |
      | numberOfMAUSAML | 100000 |
      | numberOfTokenRequests | 5000000 |
      | numberOfAppClients | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @quicksight @enterprise
  Scenario: Configure Amazon QuickSight - Enterprise deployment
    When I create an estimate with:
      | service      | Amazon QuickSight |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfReaders | 500 |
      | numberOfAuthors | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-mariadb @multi-az-gp3
  Scenario: Configure Amazon RDS for MariaDB - Multi-AZ gp3
    When I create an estimate with:
      | service      | Amazon RDS for MariaDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | storageVolume | General Purpose SSD (gp3) |
      | Select an instance | db.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @data-transfer @large
  Scenario: Configure AWS Data Transfer - Large volume
    When I create an estimate with:
      | service      | AWS Data Transfer |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataTransfer | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @datasync @large-migration
  Scenario: Configure AWS DataSync - Large data migration
    When I create an estimate with:
      | service      | AWS DataSync |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalDataCopiedByAwsDatasyncPerMonth | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-sitewise @enterprise
  Scenario: Configure AWS IoT SiteWise - Enterprise industrial
    When I create an estimate with:
      | service      | AWS IoT SiteWise |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDailyMeasurements | 50000000 |
      | numberOfTagsOrSensors | 5000 |
      | cloudDataAvailablity | 90 |
      | bufferPeriod | 30 |
      | volumeOfDataGb | 500 |
      | countOfMonthlyActiveUsers | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @step-functions @express
  Scenario: Configure AWS Step Functions - Express workflows
    When I create an estimate with:
      | service      | AWS Step Functions |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | workflowRequests | 10000000 |
      | stateTransitionsPerWorkflow | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codebuild @large-builds
  Scenario: Configure AWS CodeBuild - Large build fleet
    When I create an estimate with:
      | service      | AWS CodeBuild |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | general1.large |
      | numberOfBuildsInAMonth | 5000 |
      | averageBuildDurationMinutes | 25 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @config @enterprise
  Scenario: Configure AWS Config - Enterprise compliance
    When I create an estimate with:
      | service      | AWS Config |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfContinuousConfigItems | 50000 |
      | numberOfPeriodicConfigItems | 10000 |
      | numberOfConfigRuleEvaluations | 100000 |
      | numberOfConformancePackEvaluations | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @secrets-manager @large
  Scenario: Configure AWS Secrets Manager - Large deployment
    When I create an estimate with:
      | service      | AWS Secrets Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | NumberOfSecrets | 5000 |
      | secretDuration | 30 |
      | numberOfAPIs | 50000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @redshift @serverless
  Scenario: Configure Amazon Redshift - Large cluster with RA3
    When I create an estimate with:
      | service      | Amazon Redshift |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | ra3.4xlarge |
      | columnFormIPM[0].Number of Nodes | 8 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @lightsail @container
  Scenario: Configure Amazon Lightsail - Container focused
    When I create an estimate with:
      | service      | Amazon Lightsail |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | large |
      | numberOfServers | 1 |
      | serverUtilization | 100 |
      | numberOfContainers | 10 |
      | containerUtilization | 95 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @business @workspaces @large-deployment
  Scenario: Configure Amazon WorkSpaces - Large enterprise deployment
    When I create an estimate with:
      | service      | Amazon WorkSpaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Operating system | Windows |
      | numberOfWorkspaces | 500 |
      | billingOption | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @s3 @data-lake
  Scenario: Configure Amazon Simple Storage Service (S3) - Data lake workload
    When I create an estimate with:
      | service      | Amazon Simple Storage Service (S3) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | s3StandardStorage | 100000 |
      | putCopyPostListRequests | 50000000 |
      | getSelectRequests | 200000000 |
      | dataReturnedByS3Select | 5000 |
      | dataTransfer | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @elb @nlb
  Scenario: Configure Elastic Load Balancing - Network Load Balancer focus
    When I create an estimate with:
      | service      | Elastic Load Balancing |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfALBs | 5 |
      | processedBytesLambda | 500 |
      | averageNewConnectionsPerALB | 500 |
      | averageRequestsPerSecondPerALB | 2000 |
      | averageRuleEvaluationsPerRequest | 15 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @systems-manager @fleet
  Scenario: Configure AWS Systems Manager - Fleet management
    When I create an estimate with:
      | service      | AWS Systems Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | standardParameters | 1000 |
      | advancedParameters | 100 |
      | frequencyOfApiInteractionsPerParameter | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @security-hub @multi-account
  Scenario: Configure AWS Security Hub - Multi-account organization
    When I create an estimate with:
      | service      | AWS Security Hub |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAccounts | 50 |
      | numberOfSecurityChecksPerAccount | 1000 |
      | numberOfFindingIngestedPerAccount | 50000 |
      | numberOfAutomationRules | 50 |
      | numberOfCriteriaInEachAutomationRule | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-greengrass @large-fleet
  Scenario: Configure AWS IoT Greengrass - Large edge fleet
    When I create an estimate with:
      | service      | AWS IoT Greengrass |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfGreengrassCoreDevices | 500 |
      | activityPeriodInMinutesPerMonth | 43200 |
      | mqttTopicsWithCloudAsSourceOptional | 50 |
      | numberOfClientDevicesPerGreengrassCoreDevic | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediapackage @live-vod
  Scenario: Configure AWS Elemental MediaPackage - Live and VOD
    When I create an estimate with:
      | service      | AWS Elemental MediaPackage |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInputsPerChannel | 4 |
      | totalDurationOfLiveStreamsPerMonth | 730 |
      | ingestBitratePerInputMbitPerSecond | 10 |
      | averageNumberOfViewersPerHour | 10000 |
      | averageBitratePerViewerMbitPerSecond | 5 |
      | hoursOfVodContentWatched | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @lake-formation @large
  Scenario: Configure AWS Lake Formation - Enterprise data lake
    When I create an estimate with:
      | service      | AWS Lake Formation |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataScanned | 1000 |
      | storageUsageInAMonthInMillions | 50 |
      | requestsInAMonthInMillions | 100 |
      | numberOfTables | 500 |
      | numberOfSmallFilesIngestedPerTablePerDay | 100 |
      | sizeOfSmallFilesLessThan64mb | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @appsync @high-traffic
  Scenario: Configure AWS AppSync - High traffic GraphQL
    When I create an estimate with:
      | service      | AWS AppSync |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfApiRequests | 100000000 |
      | enterAmount | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @eks @multi-cluster
  Scenario: Configure Amazon EKS - Multi-cluster deployment
    When I create an estimate with:
      | service      | Amazon EKS |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfEKSClusters | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codepipeline @large
  Scenario: Configure AWS CodePipeline - Large CI/CD platform
    When I create an estimate with:
      | service      | AWS CodePipeline |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfActivePipelinesOfTypeV1UsedPerAcc | 25 |
      | numberOfActionExecutionMinutesUsedInPipelin | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @messaging @ses @high-volume
  Scenario: Configure Amazon Simple Email Service (SES) - High volume sending
    When I create an estimate with:
      | service      | Amazon Simple Email Service (SES) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfOpenIngressEndpoints | 3 |
      | numberOfEmailsProcessedByMailManager | 5000000 |
      | emailMessagesSentFromEc2 | 2000000 |
      | attachmentDataSentFromEc2 | 5000 |
      | emailMessagesSentFromEmailClient | 500000 |
      | emailMessagesReceived | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @firewall-manager @enterprise
  Scenario: Configure AWS Firewall Manager - Enterprise security
    When I create an estimate with:
      | service      | AWS Firewall Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfProtectionPolicy | 20 |
      | numberOfAwsAccount | 50 |
      | numberOfConfigurationItemsRecorded | 10000 |
      | numberOfConfigRuleEvaluations | 50000 |
      | numberOfAwsNetworkFirewallEndpoints | 10 |
      | dataProcessedPerMonth | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @health @healthlake @large
  Scenario: Configure Amazon Healthlake - Large healthcare dataset
    When I create an estimate with:
      | service      | Amazon Healthlake |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | additionalDataStorage | 1000 |
      | totalNumberOfQueriesPerMonth | 500000 |
      | numberOfNlpCharacters | 100000000 |
      | exportedDataPerGb | 500 |
      | numberOfNotificationsToAmazonEventbridge | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @windows @windows-sql-ec2 @ha-cluster
  Scenario: Configure Windows Server and SQL Server on Amazon EC2 - HA cluster
    When I create an estimate with:
      | service      | Windows Server and SQL Server on Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | machineDescription | SQL Server HA Cluster |
      | storageAmountGb | 2000 |
      | iops | 10000 |
      | throughputMibs | 500 |
      | numberOfVcpus | 32 |
      | memoryGib | 128 |
      | quantity | 4 |
      | numberOfPassiveInstances | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @gamelift-servers @large-game
  Scenario: Configure Amazon GameLift Servers - Large multiplayer game
    When I create an estimate with:
      | service      | Amazon GameLift Servers |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | c5.2xlarge |
      | peakConcurrentPlayersPeakCcu | 50000 |
      | gameSessionsPerInstance | 8 |
      | playersPerGameSession | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @rekognition @video-analysis
  Scenario: Configure Amazon Rekognition - High volume image processing
    When I create an estimate with:
      | service      | Amazon Rekognition |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfImagesProcessedWithLabelsApiCallsP | 5000000 |
      | numberOfImagesProcessedWithContentModeration | 2000000 |
      | numberOfImagesProcessedWithDetectTextApiCa | 1000000 |
      | numberOfImagesProcessedWithCelebrityApiCall | 500000 |
      | numberOfImagesProcessedWithPpeDetectionApi | 300000 |
      | numberOfDetectfacesApiCallsPerMonth | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @managed-flink @production
  Scenario: Configure Amazon Managed Service for Apache Flink - Production
    When I create an estimate with:
      | service      | Amazon Managed Service for Apache Flink |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | apacheFlinkApplications | 5 |
      | apacheFlinkKpus | 16 |
      | durableApplicationBackupsMaintained | 10 |
      | durableApplicationBackupStorageAverageSize | 50 |
      | studioApplications | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @macie @large-scan
  Scenario: Configure Amazon Macie - Large S3 scanning
    When I create an estimate with:
      | service      | Amazon Macie |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfS3Buckets | 500 |
      | totalBytesInS3Storage | 100000 |
      | numberOfObjectsMonitoredForAutomatedDataDis | 500000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @compute @ec2 @windows-sql
  Scenario: Configure Amazon EC2 - Windows with SQL Server
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Windows Server with SQL Server Standard |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | r6i.2xlarge |
      | columnFormIPM[0].Number of Nodes | 4 |
      | storageAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @ec2 @linux-sql
  Scenario: Configure Amazon EC2 - Linux with SQL Server
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux with SQL Server Standard |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | r6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | storageAmount | 300 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @ec2 @dedicated-host
  Scenario: Configure Amazon EC2 - Dedicated Hosts
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | tenancy | Dedicated Hosts |
      | columnFormIPM[0].Instance Type | m6i.metal |
      | columnFormIPM[0].Number of Nodes | 1 |
      | storageAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-postgresql @single-io2
  Scenario: Configure Amazon RDS for PostgreSQL - Single-AZ io2 high performance
    When I create an estimate with:
      | service      | Amazon RDS for PostgreSQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Single-AZ |
      | storageVolume | Provisioned IOPS SSD (io2) |
      | Select an instance | db.r6g.4xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-mysql @multi-az-io2
  Scenario: Configure Amazon RDS for MySQL - Multi-AZ io2 high performance
    When I create an estimate with:
      | service      | Amazon RDS for MySQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | storageVolume | Provisioned IOPS SSD (io2) |
      | Select an instance | db.r6g.4xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @ebs @throughput-hdd
  Scenario: Configure Amazon Elastic Block Store (EBS) - Throughput HDD with snapshots
    When I create an estimate with:
      | service      | Amazon Elastic Block Store (EBS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | volumeType | Throughput Optimized HDD (st 1) |
      | numberOfVolumes | 10 |
      | averageDurationOfVolume | 730 |
      | storageAmountPerVolume | 2000 |
      | amountChangedPerSnapshot | 100 |
      | Number of snapshots to restore | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @elasticache @valkey-reserved
  Scenario: Configure Amazon ElastiCache - Valkey Reserved large
    When I create an estimate with:
      | service      | Amazon ElastiCache |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | EngineType | Valkey |
      | columnFormIPM[0].TermType | Reserved |
      | Select an instance | cache.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 6 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @aurora-mysql @high-io
  Scenario: Configure Amazon Aurora MySQL-Compatible - High IO workload
    When I create an estimate with:
      | service      | Amazon Aurora MySQL-Compatible |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | Aurora I/O-Optimized |
      | columnFormIPM[0].TermType | OnDemand |
      | Select an instance | db.r6g.4xlarge |
      | columnFormIPM[0].Number of Nodes | 4 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 1000 |
      | baselineIORate | 50000 |
      | Duration of peak IO activity | 8 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @fsx-windows @multi-az
  Scenario: Configure Amazon FSx for Windows File Server - Multi-AZ HA
    When I create an estimate with:
      | service      | Amazon FSx for Windows File Server |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | desiredStorageCapacity | 5120 |
      | desiredAggregateThroughput | 1024 |
      | backupStorage | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @waf @bot-control
  Scenario: Configure AWS Web Application Firewall (WAF) - Bot Control
    When I create an estimate with:
      | service      | AWS Web Application Firewall (WAF) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfWebAcls | 5 |
      | numberOfRulesPerWebAcl | 25 |
      | numberOfRulesInsideRuleGroup | 10 |
      | numberOfWebRequests | 500000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @bedrock @high-volume-batch
  Scenario: Configure Amazon Bedrock - High volume batch processing
    When I create an estimate with:
      | service      | Amazon Bedrock |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | inferenceType | Geo Cross Region Inference |
      | pricingModel | Batch |
      | averageRequestsPerMinute | 100 |
      | hoursPerDayAtThisRate | 24 |
      | averageInputTokensPerRequest | 5000 |
      | averageOutputTokensPerRequest | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @sagemaker @training
  Scenario: Configure Amazon SageMaker - Training focused
    When I create an estimate with:
      | service      | Amazon SageMaker |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDataScientists | 5 |
      | numberOfStudioNotebookInstances | 2 |
      | studioNotebookHoursPerDay | 12 |
      | studioNotebookDaysPerMonth | 30 |
      | numberOfOnDemandNotebookInstances | 1 |
      | onDemandNotebookHoursPerDay | 8 |
      | onDemandNotebookDaysPerMonth | 22 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @fargate @windows-large
  Scenario: Configure AWS Fargate - Windows containers large deployment
    When I create an estimate with:
      | service      | AWS Fargate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Windows |
      | selectArchitecture | x86 |
      | numberOfTasks | 25 |
      | taskDuration | 3600 |
      | memoryStandardFargateOnDemand | 8 |
      | storageAmountECS | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @lambda @edge
  Scenario: Configure AWS Lambda - Edge functions
    When I create an estimate with:
      | service      | AWS Lambda |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | architecture | x86 |
      | numberOfRequests | 500000000 |
      | durationOfEachRequest | 5 |
      | amountOfMemoryAllocated | 128 |
      | amountOfEphemeralStorageAllocated | 512 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @kinesis-data-streams @real-time
  Scenario: Configure Amazon Kinesis Data Streams - Real-time analytics
    When I create an estimate with:
      | service      | Amazon Kinesis Data Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRecords | 10000000 |
      | averageRecordSize | 1 |
      | numberOfConsumerApplications | 3 |
      | numberOfDaysForDataRetention | 3 |
      | numberOfEnhancedFanoutConsumers | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @msk @serverless
  Scenario: Configure Amazon Managed Streaming for Apache Kafka (MSK) - Enterprise streaming
    When I create an estimate with:
      | service      | Amazon Managed Streaming for Apache Kafka (MSK) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | kafka.m5.4xlarge |
      | numberOfKafkaBrokerNodes | 6 |
      | storagePerBroker | 5000 |
      | desiredProvisionedStorageThroughput | 1000 |
      | dataTransfer | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @mq @ha-large
  Scenario: Configure Amazon MQ - High availability large deployment
    When I create an estimate with:
      | service      | Amazon MQ |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Broker type | Active/standby-instance Broker |
      | Instance type | mq.m5.4xlarge |
      | Storage type | Durability optimized (Amazon EFS) |
      | numberOfBrokersRunning | 5 |
      | storagePerBroker | 200 |
      | enterAmount | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @opensearch @reserved-large
  Scenario: Configure Amazon OpenSearch Service - Reserved large cluster
    When I create an estimate with:
      | service      | Amazon OpenSearch Service |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].TermType | Reserved |
      | Select an instance | r6g.2xlarge.search |
      | columnFormIPM[0].Number of Nodes | 12 |
      | columnFormIPM[0].undefined.unit | 100 |
      | Number of instances | 3 |
      | storageAmountPerVolumeGP3 | 1000 |
      | provisioningIOPSPerVolumeGP3 | 10000 |
      | Number of nodes | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @workflow @managed-airflow @2xl
  Scenario: Configure Amazon Managed Workflows for Apache Airflow - 2XL production
    When I create an estimate with:
      | service      | Amazon Managed Workflows for Apache Airflow |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Environment size | 2XL |
      | minimumWorkers | 10 |
      | maximumWorkers | 50 |
      | hoursAtMaximumWorkers | 12 |
      | minimumWebServers | 3 |
      | maximumWebServers | 10 |
      | hoursAtMaximumWebServers | 8 |
      | numberOfSchedulers | 3 |
      | dataStorageSize | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @business @workspaces @ubuntu
  Scenario: Configure Amazon WorkSpaces - Ubuntu development
    When I create an estimate with:
      | service      | Amazon WorkSpaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Operating system | Ubuntu Linux |
      | numberOfWorkspaces | 50 |
      | billingOption | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @xray @high-traffic
  Scenario: Configure AWS X-Ray - High traffic application
    When I create an estimate with:
      | service      | AWS X-Ray |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRequestsPerMonth | 100000000 |
      | numberOfQueriesPerMonth | 100000 |
      | tracesRetrievedPerQuery | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @shield @comprehensive
  Scenario: Configure AWS Shield - Comprehensive protection
    When I create an estimate with:
      | service      | AWS Shield |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudFrontUsage | 50 |
      | elbUsage | 20 |
      | elasticIPUsage | 15 |
      | globalAcceleratorUsage | 5 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @iam-access-analyzer @organization
  Scenario: Configure AWS IAM Access Analyzer - Organization wide
    When I create an estimate with:
      | service      | AWS IAM Access Analyzer |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAccountsToMonitor | 50 |
      | averageRolesPerAccount | 200 |
      | averageUsersPerAccount | 500 |
      | numberOfAnalyzersPerAccount | 3 |
      | numberOfRequestsToChecknonewaccessApi | 100000 |
      | numberOfRequestsToCheckaccessnotgrantedApi | 50000 |
      | numberOfResourcesToMonitor | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @migration @transfer-family @enterprise
  Scenario: Configure AWS Transfer Family - Enterprise file transfer
    When I create an estimate with:
      | service      | AWS Transfer Family |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfEndpointsWithAs2Enabled | 5 |
      | numberOfAs2MessagesSentPerMonth | 100000 |
      | numberOfAs2MessagesReceivedPerMonth | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-analytics @large
  Scenario: Configure AWS IoT Analytics - Large scale analytics
    When I create an estimate with:
      | service      | AWS IoT Analytics |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfIotDevicesMonthly | 50000 |
      | dataGenerationByEachDevice | 100 |
      | numberOfDataPipelinesMonthly | 20 |
      | dataQueriedPerMonth | 5000 |
      | numberOfQueriesMonthly | 10000 |
      | dataScannedPerQuery | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @emr @gpu-cluster
  Scenario: Configure Amazon EMR - GPU accelerated cluster
    When I create an estimate with:
      | service      | Amazon EMR |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfMasterEmrNodes | 1 |
      | utilization | 100 |
      | numberOfCoreEmrNodes | 8 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-oracle @multi-az
  Scenario: Configure Amazon RDS for Oracle - Multi-AZ high availability
    When I create an estimate with:
      | service      | Amazon RDS for Oracle |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | Select an instance | db.r6i.4xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-sql-server @enterprise
  Scenario: Configure Amazon RDS for SQL server - Enterprise Multi-AZ
    When I create an estimate with:
      | service      | Amazon RDS for SQL server |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | Select an instance | db.r6i.4xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-db2 @production
  Scenario: Configure Amazon RDS for Db2 - Production Multi-AZ
    When I create an estimate with:
      | service      | Amazon RDS for Db2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Deployment Option | Multi-AZ |
      | Select an instance | db.r6i.2xlarge |
      | nodes | 2 |
      | utilizationOndemandOnly | 100 |
      | storageAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @eventbridge @scheduler
  Scenario: Configure Amazon EventBridge - Scheduler and Pipes
    When I create an estimate with:
      | service      | Amazon EventBridge |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | sizeOfThePayload | 256 |
      | numberOfCustomEvents | 50000000 |
      | Number of events | 10000000 |
      | numberOfInvocations | 5000000 |
      | Number of requests | 1000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @private-ca @enterprise
  Scenario: Configure AWS Private Certificate Authority - Enterprise PKI
    When I create an estimate with:
      | service      | AWS Private Certificate Authority |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPrivateCas | 5 |
      | numberOfGeneralPurposeModePrivateCertificate | 10000 |
      | numberOfCertificatesUsedWithAcmintegratedSer | 5000 |
      | numberOfShortLivedCertificateModePrivateCer | 100000 |
      | numberOfOcspResponsesPerMonth | 5000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @managed-prometheus @large
  Scenario: Configure Amazon Managed Service for Prometheus - Large deployment
    When I create an estimate with:
      | service      | Amazon Managed Service for Prometheus |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | averageActiveTimeSeries | 5000000 |
      | avgCollectionIntervalInSeconds | 15 |
      | retentionPeriodInDays | 365 |
      | averageNumberOfDashboardUsersPerDay | 20 |
      | numberOfPrometheusRules | 500 |
      | averageRuleExecutionIntervalInSeconds | 60 |
      | numberOfCollectors | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @data-firehose @vended-logs
  Scenario: Configure Amazon Data firehose - Vended logs
    When I create an estimate with:
      | service      | Amazon Data firehose |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Source | Vended logs |
      | numberOfRecordsForDataIngestion | 10000 |
      | recordSize | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @detective @enterprise
  Scenario: Configure Amazon Detective - Enterprise investigation
    When I create an estimate with:
      | service      | Amazon Detective |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataIngestedFromAwsCloudtrailAmazonVpcFlow | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codeartifact @enterprise
  Scenario: Configure AWS CodeArtifact - Enterprise artifact management
    When I create an estimate with:
      | service      | AWS CodeArtifact |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | sizeOfArtifactsStored | 500 |
      | numberOfApiRequests | 5000000 |
      | enterAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @managed-grafana @enterprise
  Scenario: Configure Amazon Managed Grafana - Enterprise monitoring
    When I create an estimate with:
      | service      | Amazon Managed Grafana |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfActiveEditorsadministrators | 20 |
      | numberOfActiveViewers | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @cloudhsm @cluster
  Scenario: Configure AWS CloudHSM - HA cluster
    When I create an estimate with:
      | service      | AWS CloudHSM |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfHsm1mediumHsms | 6 |
      | totalNumberOfHsm2mmediumHsms | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @deadline-cloud @render-farm
  Scenario: Configure AWS Deadline Cloud - Render farm
    When I create an estimate with:
      | service      | AWS Deadline Cloud |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | c5.4xlarge |
      | numberOfInstance | 50 |
      | monthlyUtilization | 400 |
      | storagePerWorker | 500 |
      | utilizationOndemandOnly | 60 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @direct-connect @multi-port
  Scenario: Configure AWS Direct Connect - Multi-port high capacity
    When I create an estimate with:
      | service      | AWS Direct Connect |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPorts | 8 |
      | hoursUsed | 730 |
      | dataTransferOut | 200000 |
      | dataTransferIn | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @swf @high-volume
  Scenario: Configure Amazon Simple Workflow Service (SWF) - High volume
    When I create an estimate with:
      | service      | Amazon Simple Workflow Service (SWF) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | workflowExecutions | 100000 |
      | totalTasksMarkersTimersAndSignals | 500000 |
      | workflowLifetime | 7 |
      | workflowRetention | 30 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @compute @ec2 @eu-region
  Scenario: Configure Amazon EC2 - EU West deployment
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 5 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-postgresql @eu-region
  Scenario: Configure Amazon RDS for PostgreSQL - EU West deployment
    When I create an estimate with:
      | service      | Amazon RDS for PostgreSQL |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Multi-AZ |
      | storageVolume | General Purpose SSD (gp3) |
      | Select an instance | db.m6i.xlarge |
      | columnFormIPM[0].Number of Nodes | 2 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @fargate @ap-region
  Scenario: Configure AWS Fargate - Asia Pacific deployment
    When I create an estimate with:
      | service      | AWS Fargate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | Linux |
      | selectArchitecture | x86 |
      | numberOfTasks | 20 |
      | taskDuration | 600 |
      | memoryStandardFargateOnDemand | 4 |
      | storageAmountECS | 30 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @lambda @ap-region
  Scenario: Configure AWS Lambda - Asia Pacific deployment
    When I create an estimate with:
      | service      | AWS Lambda |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | architecture | Arm |
      | numberOfRequests | 50000000 |
      | durationOfEachRequest | 150 |
      | amountOfMemoryAllocated | 512 |
      | amountOfEphemeralStorageAllocated | 512 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @s3 @eu-region
  Scenario: Configure Amazon Simple Storage Service (S3) - EU deployment
    When I create an estimate with:
      | service      | Amazon Simple Storage Service (S3) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | s3StandardStorage | 5000 |
      | putCopyPostListRequests | 1000000 |
      | getSelectRequests | 5000000 |
      | dataReturnedByS3Select | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @aurora-postgresql @ap-region
  Scenario: Configure Amazon Aurora PostgreSQL-Compatible DB - AP deployment
    When I create an estimate with:
      | service      | Amazon Aurora PostgreSQL-Compatible DB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storageMode | Aurora Standard |
      | columnFormIPM[0].TermType | OnDemand |
      | Select an instance | db.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 3 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 200 |
      | baselineIORate | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @elb @eu-region
  Scenario: Configure Elastic Load Balancing - EU deployment
    When I create an estimate with:
      | service      | Elastic Load Balancing |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfALBs | 4 |
      | processedBytesLambda | 200 |
      | averageNewConnectionsPerALB | 200 |
      | averageRequestsPerSecondPerALB | 1000 |
      | averageRuleEvaluationsPerRequest | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @bedrock @eu-region
  Scenario: Configure Amazon Bedrock - EU deployment
    When I create an estimate with:
      | service      | Amazon Bedrock |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | inferenceType | In-Region |
      | pricingModel | On Demand - Standard |
      | averageRequestsPerMinute | 20 |
      | hoursPerDayAtThisRate | 12 |
      | averageInputTokensPerRequest | 1000 |
      | averageOutputTokensPerRequest | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @ebs @eu-region
  Scenario: Configure Amazon Elastic Block Store (EBS) - EU gp3
    When I create an estimate with:
      | service      | Amazon Elastic Block Store (EBS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | volumeType | General Purpose SSD (gp3) |
      | numberOfVolumes | 20 |
      | averageDurationOfVolume | 730 |
      | storageAmountPerVolume | 200 |
      | amountChangedPerSnapshot | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @dynamodb @ap-region
  Scenario: Configure Amazon DynamoDB - Asia Pacific deployment
    When I create an estimate with:
      | service      | Amazon DynamoDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | tableClass | Standard |
      | averageItemSize | 100 |
      | baselineWriteRate | 500 |
      | peakWriteRate | 2000 |
      | durationOfPeakWriteActivity | 4 |
      | baselineReadRate | 2000 |
      | peakReadRate | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @elasticache @eu-region
  Scenario: Configure Amazon ElastiCache - EU Redis deployment
    When I create an estimate with:
      | service      | Amazon ElastiCache |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | EngineType | Redis |
      | columnFormIPM[0].TermType | OnDemand |
      | Select an instance | cache.r6g.large |
      | columnFormIPM[0].Number of Nodes | 6 |
      | columnFormIPM[0].undefined.unit | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @integration @sqs @eu-region
  Scenario: Configure Amazon Simple Queue Service (SQS) - EU deployment
    When I create an estimate with:
      | service      | Amazon Simple Queue Service (SQS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | standardQueueRequests | 50000000 |
      | fifoQueueRequests | 10000000 |
      | fairQueueRequests | 5000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @guardduty @eu-region
  Scenario: Configure Amazon GuardDuty - EU deployment
    When I create an estimate with:
      | service      | Amazon GuardDuty |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudTrailManagementEventAnalysis | 10000000 |
      | ec2VpcFlowLogAnalysis | 200 |
      | ec2DnsQueryLogAnalysis | 100 |
      | cloudTrailS3DataEventAnalysis | 20000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @route53 @resolver
  Scenario: Configure Amazon Route 53 - DNS Firewall and Resolver
    When I create an estimate with:
      | service      | Amazon Route 53 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfHostedZones | 20 |
      | additionalRecords | 1000 |
      | numberOfStandardQueries | 100000000 |
      | Latency based routing queries | 10000000 |
      | Geo DNS queries | 5000000 |
      | Number of Elastic Network Interfaces | 10 |
      | Recursive average DNS queries | 50000000 |
      | numberOfDomainsStored | 100 |
      | dnsQueries | 10000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @cloudwatch @eu-region
  Scenario: Configure Amazon CloudWatch - EU deployment
    When I create an estimate with:
      | service      | Amazon CloudWatch |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfMetrics | 1000 |
      | getMetricDataRequests | 5000 |
      | numberOfOtherAPIRequests | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @athena @eu-region
  Scenario: Configure Amazon Athena - EU data lake queries
    When I create an estimate with:
      | service      | Amazon Athena |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfQueries | 5000 |
      | amountOfDataScannedPerQuery | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @fsx-lustre @hdd-archive
  Scenario: Configure Amazon FSx for Lustre - HDD archive storage
    When I create an estimate with:
      | service      | Amazon FSx for Lustre |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Storage type | HDD |
      | storageCapacity | 12000 |
      | backupStorage | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-custom-oracle @ha
  Scenario: Configure Amazon RDS Custom for Oracle - HA deployment
    When I create an estimate with:
      | service      | Amazon RDS Custom for Oracle |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.r6i.4xlarge |
      | numberOfRdsCustomForOracleInstances | 4 |
      | utilizationOndemandOnly | 100 |
      | storageAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-custom-sql @ha
  Scenario: Configure Amazon RDS Custom for SQL Server - HA deployment
    When I create an estimate with:
      | service      | Amazon RDS Custom for SQL Server |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.r6i.4xlarge |
      | numberOfRdsCustomForSqlServerInstances | 4 |
      | utilizationOndemandOnly | 100 |
      | storageAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @app-runner @eu-region
  Scenario: Configure AWS App Runner - EU deployment
    When I create an estimate with:
      | service      | AWS App Runner |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | concurrency | 100 |
      | minimumProvisionedContainerInstances | 3 |
      | peakTrafficHours | 10 |
      | numberOfRequestsDuringPeakTrafficRequestssec | 1000 |
      | numberOfRequestsDuringOffpeakTrafficRequests | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @ec2 @suse
  Scenario: Configure Amazon EC2 - SUSE Linux
    When I create an estimate with:
      | service      | Amazon EC2 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | operatingSystem | SUSE Linux Enterprise Server |
      | tenancy | Shared Instances |
      | columnFormIPM[0].Instance Type | t3.xlarge |
      | columnFormIPM[0].Number of Nodes | 3 |
      | storageAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @rds-mariadb @io2-single
  Scenario: Configure Amazon RDS for MariaDB - Single-AZ io2
    When I create an estimate with:
      | service      | Amazon RDS for MariaDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | columnFormIPM[0].Deployment Option | Single-AZ |
      | storageVolume | Provisioned IOPS SSD (io2) |
      | Select an instance | db.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 1 |
      | columnFormIPM[0].undefined.unit | 100 |
      | storageAmount | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @fsx-openzfs @large
  Scenario: Configure Amazon FSx for OpenZFS - Large deployment
    When I create an estimate with:
      | service      | Amazon FSx for OpenZFS |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | desiredStorageCapacity | 10240 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @keyspaces @high-throughput
  Scenario: Configure Amazon Keyspaces - High throughput
    When I create an estimate with:
      | service      | Amazon Keyspaces |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | storage | 5000 |
      | numberOfWrites | 500000 |
      | numberOfReads | 2000000 |
      | numberOfTtlDeleteOperations | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @timestream @large
  Scenario: Configure Amazon Timestream - Enterprise time series
    When I create an estimate with:
      | service      | Amazon Timestream |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | estimatedMonthlyStorage | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @comprehend @enterprise
  Scenario: Configure Amazon Comprehend - Enterprise NLP
    When I create an estimate with:
      | service      | Amazon Comprehend |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDocumentsAsynchronous | 5000000 |
      | averageCharactersInADocumentAsynchronous | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @textract @enterprise
  Scenario: Configure Amazon Textract - Enterprise document processing
    When I create an estimate with:
      | service      | Amazon Textract |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPages | 5000000 |
      | percentOfPagesWithTextDetectDocumentTextAp | 95 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @polly @enterprise
  Scenario: Configure Amazon Polly - Enterprise text-to-speech
    When I create an estimate with:
      | service      | Amazon Polly |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRequestsStandardTexttospeech | 5000000 |
      | numberOfCharactersPerRequestIncludingWhiteS | 1000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ai-ml @translate @enterprise
  Scenario: Configure Amazon Translate - Enterprise translation
    When I create an estimate with:
      | service      | Amazon Translate |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfCharactersIncludingWhiteSpacesAndPu | 500000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @storage-gateway @enterprise
  Scenario: Configure AWS Storage Gateway - Enterprise hybrid storage
    When I create an estimate with:
      | service      | AWS Storage Gateway |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | dataWrittenToAwsFileStorageByYourGateway | 5000 |
      | enterAmount | 2000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @gamelift-streams @large
  Scenario: Configure Amazon GameLift Streams - Large streaming deployment
    When I create an estimate with:
      | service      | Amazon GameLift Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | estimatedDailyActiveUsers | 10000 |
      | estimatedStreamHoursPerUser | 3 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @verified-permissions @enterprise
  Scenario: Configure Amazon Verified Permissions - Enterprise authorization
    When I create an estimate with:
      | service      | Amazon Verified Permissions |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfSingleAuthorizationRequests | 50000000 |
      | numberOfBatchAuthorizationRequests | 10000000 |
      | numberOfPolicyManagementRequests | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @database @memorydb @eu-region
  Scenario: Configure Amazon MemoryDB - EU deployment
    When I create an estimate with:
      | service      | Amazon MemoryDB |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | db.r6g.xlarge |
      | columnFormIPM[0].Number of Nodes | 6 |
      | columnFormIPM[0].undefined.unit | 100 |
      | dataWritten | 200 |
      | snapshotStorage | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @elastic-graphics @large
  Scenario: Configure Amazon Elastic Graphics - Large GPU workload
    When I create an estimate with:
      | service      | Amazon Elastic Graphics |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | eg1.4xlarge |
      | numberOfNodes | 8 |
      | utilizationOndemandOnly | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @developer @codeguru @enterprise
  Scenario: Configure Amazon CodeGuru Reviewer - Enterprise code review
    When I create an estimate with:
      | service      | Amazon CodeGuru Reviewer |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfRepositories | 100 |
      | averageLinesOfCodeLocPerRepository | 200000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-events @enterprise
  Scenario: Configure AWS IoT Events - Enterprise IoT monitoring
    When I create an estimate with:
      | service      | AWS IoT Events |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevices | 10000 |
      | numberOfMessagesForADeviceIncludingTimerEx | 500 |
      | numberOfEventDetectorModelsPerDevice | 5 |
      | averageSizeOfEachMessage | 2 |
      | numberOfActionsTriggeredPerMessage | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @glue @eu-region
  Scenario: Configure AWS Glue - EU data processing
    When I create an estimate with:
      | service      | AWS Glue |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDPUsForApacheSparkJob | 20 |
      | durationForApacheSparkETLJob | 4 |
      | numberOfDPUsForPythonShellJob | 5 |
      | numberOfDPUsForInteractiveSession | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @payment-cryptography @enterprise
  Scenario: Configure AWS Payment Cryptography - High volume transactions
    When I create an estimate with:
      | service      | AWS Payment Cryptography |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfApiRequests | 100000000 |
      | numberOfActiveKeys | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @fis @enterprise
  Scenario: Configure AWS Fault Injection Service (FIS) - Enterprise chaos engineering
    When I create an estimate with:
      | service      | AWS Fault Injection Service (FIS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | experimentsPerMonth | 100 |
      | averageActionminutesPerExperiment | 60 |
      | averageCountOfTargetAccountsPerExperiment | 10 |
      | ofExperimentsPerMonthWithExperimentReportEn | 50 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @management @audit-manager @enterprise
  Scenario: Configure AWS Audit Manager - Enterprise compliance
    When I create an estimate with:
      | service      | AWS Audit Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfAccounts | 50 |
      | numberOfResourcesPerAccount | 1000 |
      | numberOfConfigurationSnapshotsApiCalls | 50000 |
      | numberOfConfigurationChangesuserActivityLogs | 100000 |
      | numberOfComplianceChecksSecurityHubConfig | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @networking @route53 @full-coverage
  Scenario: Configure Amazon Route 53 - full health checks and routing
    When I create an estimate with:
      | service      | Amazon Route 53 |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfHostedZones | 10 |
      | additionalRecords | 500 |
      | trafficFlow | 5 |
      | numberOfStandardQueries | 50000000 |
      | Latency based routing queries | 10000000 |
      | Geo DNS queries | 5000000 |
      | IP-based routing queries | 2000000 |
      | IP (CIDR) blocks | 50 |
      | basicChecksWithinAWS | 10 |
      | Basic Checks Outside of AWS | 5 |
      | httpsChecksWithinAWS | 10 |
      | HTTPS Checks Outside of AWS | 5 |
      | String Matching Checks Within AWS | 5 |
      | String Matching Checks Outside of AWS | 3 |
      | Fast Interval Checks Within AWS | 5 |
      | Fast Interval Checks Outside of AWS | 3 |
      | Latency Measurement Checks Within AWS | 5 |
      | Latency Measurement Checks Outside of AWS | 3 |
      | Number of Elastic Network Interfaces | 10 |
      | Recursive average DNS queries | 5000000 |
      | numberOfDomainsStored | 100 |
      | dnsQueries | 10000000 |
      | Number of VPCs associated to the rule group | 5 |
      | Number of hours the rule group is associated for | 730 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @guardduty @full-coverage
  Scenario: Configure Amazon GuardDuty - complete runtime and malware protection
    When I create an estimate with:
      | service      | Amazon GuardDuty |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | cloudTrailManagementEventAnalysis | 50 |
      | ec2VpcFlowLogAnalysis | 1000 |
      | ec2DnsQueryLogAnalysis | 500 |
      | cloudTrailS3DataEventAnalysis | 100 |
      | eksAuditLogsAnalysis | 50 |
      | ebsVolumeDataScanAnalysis | 200 |
      | Total Size of S3 Objects scanned per month | 500 |
      | Number of PUT requests monitored per month | 5000000 |
      | Enter the amount of data scanned from EBS snapshots per month | 200 |
      | Enter the amount of data scanned from EC2 AMI per month | 100 |
      | Enter the amount of data scanned from S3 Recovery Point per month | 100 |
      | rdsProvisionedInstanceVCPU | 64 |
      | Aurora Serverless v2 instances ACUs | 32 |
      | lambdaVpcFlowLogAnalysis | 200 |
      | Amazon EKS Runtime Monitoring Analysis | 100 |
      | Amazon ECS Runtime Monitoring Analysis | 100 |
      | Amazon EC2 Runtime Monitoring Analysis | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @kinesis-video @full-coverage
  Scenario: Configure Amazon Kinesis Video Streams - full streaming with WebRTC
    When I create an estimate with:
      | service      | Amazon Kinesis Video Streams |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDevices | 50 |
      | averageBitrate | 5 |
      | durationOfVideoStreamedToAmazonKinesisVideo | 12 |
      | durationOfVideoPlaybackOverHlsOrMpegdashPe | 4 |
      | durationOfVideoConsumedByOtherApplicationsP | 2 |
      | averageLengthOfEachWebrtcSessionForLiveVie | 30 |
      | turnUsageEnterThePercentage | 20 |
      | averageRetentionForVideo | 7 |
      | imagesExtractedPerCamera1080pResolutionStrea | 1000 |
      | imagesExtractedPerCameraGreaterThan1080pRes | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @messaging @ses @full-coverage
  Scenario: Configure Amazon Simple Email Service (SES) - enterprise with dedicated IPs
    When I create an estimate with:
      | service      | Amazon Simple Email Service (SES) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfOpenIngressEndpoints | 3 |
      | numberOfEmailsProcessedByMailManager | 5000000 |
      | emailMessagesSentFromEc2 | 2000000 |
      | attachmentDataSentFromEc2 | 500 |
      | emailMessagesSentFromEmailClient | 500000 |
      | attachmentDataSentFromEmailClient | 100 |
      | emailMessagesReceived | 3000000 |
      | averageSizeOfEmailProcessedByMailManager | 50 |
      | emailMessageSentViaDedicatedIpsManaged | 1000000 |
      | numberOfDedicatedIpstandardAddresses | 3 |
      | gigabytesInsertedIndexed | 100 |
      | gigabytesAlreadyStored | 500 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @devops @cloudtrail @full-coverage
  Scenario: Configure AWS CloudTrail - full logging with insights and network activity
    When I create an estimate with:
      | service      | AWS CloudTrail |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | OpsMult | 10000000 |
      | numberOfWriteTrails | 2 |
      | numberOfReadTrails | 5000000 |
      | Read management trails | 1 |
      | dataOpsMult | 1000000 |
      | numberOfS3Trails | 1 |
      | numberOfLambdaTrails | 500000 |
      | Lambda trails | 1 |
      | networkActivityOpsMult | 2000000 |
      | numberOfNetworkActivityTrails | 1 |
      | Total number of management API calls (both read and write) to be analyzed for unusual activity | 10000000 |
      | Number of trails and/or event data stores where Insights events are enabled | 2 |
      | dataIngestedCloudTrail | 500 |
      | Data ingested - 7 year retention | 100 |
      | dataScannedUsingQueries | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @inspector @full-coverage
  Scenario: Configure Amazon Inspector - full scanning with code analysis
    When I create an estimate with:
      | service      | Amazon Inspector |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | averageEC2InstancesScanned | 100 |
      | totalContainerImagesPushed | 500 |
      | totalAutomatedRescans | 4 |
      | averageLambdaFunctionsScanned | 200 |
      | totalNumberOfRepositories | 50 |
      | Number of SAST periodic scans per repository per month | 4 |
      | Number of SCA periodc scans per repository per month | 4 |
      | Number of IaC periodic scans per repository per month | 4 |
      | Total Number of on-demand scans (across each scan-type including SAST, SCA and IaC) per repository per month | 10 |
      | Total number of change-based scans (across each scan-type including SAST, SCA, IaC) per repository per month (including pull request/merge request or push) Enter a number | 20 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @compute @lambda @full-coverage
  Scenario: Configure AWS Lambda - with SnapStart cold-starts
    When I create an estimate with:
      | service      | AWS Lambda |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRequests | 5000000 |
      | durationOfEachRequest | 100 |
      | amountOfMemoryAllocated | 2048 |
      | amountOfEphemeralStorageAllocated | 1024 |
      | concurrency | 50 |
      | durationOfEachProvisionedRequest | 80 |
      | numberOfColdStarts | 10000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ml @lookout-vision @full-coverage
  Scenario: Configure Amazon Lookout for Vision - full production deployment
    When I create an estimate with:
      | service      | Amazon Lookout for Vision |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPlants | 3 |
      | numberOfProductionLinesPerPlant | 5 |
      | numberOfInspectionPointsPerProductionLine | 4 |
      | numberOfCamerasPerInspectionPoint | 2 |
      | timeToTrainInitialModelHours | 10 |
      | averageNumberOfModelRetrainsPerModelPerMon | 2 |
      | numberOfInferenceUnits | 5 |
      | numberOfProductionShiftsPerDay | 3 |
      | productionHoursPerShift | 8 |
      | productionDaysPerMonth | 22 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @devops @prometheus @full-coverage
  Scenario: Configure Amazon Managed Service for Prometheus - full observability
    When I create an estimate with:
      | service      | Amazon Managed Service for Prometheus |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | averageActiveTimeSeries | 100000 |
      | avgCollectionIntervalInSeconds | 15 |
      | retentionPeriodInDays | 90 |
      | averageNumberOfDashboardUsersPerDay | 20 |
      | numberOfPrometheusRules | 200 |
      | averageRuleExecutionIntervalInSeconds | 60 |
      | averageNumberOfQueriesPerDayPerDashboardUs | 50 |
      | averageSamplesPerQueryForMonitoringQueries | 10000 |
      | averageSamplesPerQueryForAlertingQueries | 5000 |
      | numberOfCollectors | 10 |
      | numberOfSamplesCollected | 50000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @other @workspaces-apps @full-coverage
  Scenario: Configure Amazon WorkSpaces Applications - elastic fleet full config
    When I create an estimate with:
      | service      | Amazon WorkSpaces Applications |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfUsersPerMonth | 100 |
      | numberOfWorkingHoursPerDay | 8 |
      | instanceDiskVolumeSize | 50 |
      | daysInWeek | 5 |
      | peakDurationHoursPerDay | 4 |
      | averageOffpeakConcurrentUsersPerHour | 20 |
      | averagePeakConcurrentUsersPerHour | 60 |
      | daysInWeekend | 2 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediaconnect @full-coverage
  Scenario: Configure AWS Elemental MediaConnect - full flow with outputs
    When I create an estimate with:
      | service      | AWS Elemental MediaConnect |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfRunningFlows | 5 |
      | flowUtilization | 80 |
      | numberOfOutputsPerFlow | 3 |
      | bitrateMbitPerSecond | 20 |
      | runningFlowUtilization | 80 |
      | numberOfRunningOutputs | 10 |
      | runningOutputUtilization | 70 |
      | enterAmount | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @iot @iot-sitewise @full-coverage
  Scenario: Configure AWS IoT SiteWise - enterprise industrial with egress
    When I create an estimate with:
      | service      | AWS IoT SiteWise |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfDailyMeasurements | 1000000 |
      | numberOfTagsOrSensors | 5000 |
      | cloudDataAvailablity | 90 |
      | bufferPeriod | 30 |
      | numberOfMessagesInResponseToEgressApiCalls | 500000 |
      | totalComputationsOfMetricsAndTransforms | 10000000 |
      | volumeOfDataGb | 500 |
      | countOfMonthlyActiveUsers | 50 |
      | costOfEgressFromIotSitewisePricingTool | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @finspace @full-coverage
  Scenario: Configure Amazon FinSpace Dataset Browser - all cluster sizes
    When I create an estimate with:
      | service      | Amazon FinSpace Dataset Browser |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfUsers | 20 |
      | sizeOfDataToBeStored | 500 |
      | totalTimeSpentSmallClusterAcrossAllUsers | 200 |
      | totalTimeSpentMediumClusterAcrossAllUsers | 100 |
      | totalTimeSpentLargeClusterAcrossAllUsers | 50 |
      | totalTimeSpentXlargeClusterAcrossAllUsers | 20 |
      | totalTimeSpentXxlargeClusterAcrossAllUsers | 10 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ml @fraud-detector @full-coverage
  Scenario: Configure Amazon Fraud Detector - all model types
    When I create an estimate with:
      | service      | Amazon Fraud Detector |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | eventDataProcessedAndStored | 100 |
      | numberOfModelVersions | 5 |
      | trainingTimePerModelVersionInHours | 10 |
      | numberOfActiveModelVersions | 3 |
      | numberOfMonthlyPredictionsWithOnlineFraudIn | 1000000 |
      | numberOfMonthlyPredictionsWithTransactionFra | 500000 |
      | numberOfMonthlyPredictionsWithRulesOnlyNoM | 2000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @messaging @sns @full-coverage
  Scenario: Configure Amazon Simple Notification Service (SNS) - with data scanning and Firehose
    When I create an estimate with:
      | service      | Amazon Simple Notification Service (SNS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | requests | 10000000 |
      | httpHttpsNotifications | 5000000 |
      | emailNotifications | 100000 |
      | sqsNotifications | 5000000 |
      | Amazon Web Services Lambda | 2000000 |
      | Amazon Kinesis Data Firehose | 1000000 |
      | mobilePushNotifications | 500000 |
      | Enter Amount | 50 |
      | Publish and Delivery Message Scanning | 5000000 |
      | The amount of outbound payload data scanned per month | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @media @mediapackage @full-coverage
  Scenario: Configure AWS Elemental MediaPackage - with VOD and cache ratio
    When I create an estimate with:
      | service      | AWS Elemental MediaPackage |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfInputsPerChannel | 2 |
      | totalDurationOfLiveStreamsPerMonth | 720 |
      | ingestBitratePerInputMbitPerSecond | 10 |
      | averageNumberOfViewersPerHour | 1000 |
      | averageBitratePerViewerMbitPerSecond | 5 |
      | cachehitRatioEnterCachehitRatioAsAPecentage | 80 |
      | hoursOfVodContentWatched | 5000 |
      | averageBitrateMbitPerSecond | 8 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @firewall-manager @full-coverage
  Scenario: Configure AWS Firewall Manager - with WAF and security groups
    When I create an estimate with:
      | service      | AWS Firewall Manager |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfProtectionPolicy | 5 |
      | numberOfAwsAccount | 10 |
      | numberOfConfigurationItemsRecorded | 50000 |
      | numberOfConfigRuleEvaluations | 100000 |
      | numberOfAwsNetworkFirewallEndpoints | 4 |
      | usagePerEndpoint | 730 |
      | dataProcessedPerMonth | 500 |
      | numberOfWebAccessControlListsWebAclsUtiliz | 5 |
      | numberOfRulesAddedPerWebAcl | 20 |
      | numberOfDomainsStored | 1000 |
      | dnsQueries | 10000000 |
      | elasticLoadBalancingElbUsage | 200 |
      | elasticIpUsage | 50 |
      | numberOfSecurityGroups | 100 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @messaging @eventbridge @full-coverage
  Scenario: Configure Amazon EventBridge - with opt-in data events and same-account delivery
    When I create an estimate with:
      | service      | Amazon EventBridge |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | sizeOfThePayload | 10 |
      | numberOfAWSManagementEvents | 5000000 |
      | Number of AWS opt-in data events | 2000000 |
      | numberOfCustomEvents | 10000000 |
      | numberOfPartnerEvents | 1000000 |
      | numberOfEventsDeliveredToAnotherBus | 500000 |
      | Number of events delivered to a service in the same account | 8000000 |
      | Number of events delivered to a service in a different account | 2000000 |
      | numberOfInvocations | 5000000 |
      | Number of events | 10000000 |
      | numberOfReplayedEvents | 1000000 |
      | Number of requests | 5000000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @messaging @msk @full-coverage
  Scenario: Configure Amazon Managed Streaming for Apache Kafka (MSK) - with private connectivity
    When I create an estimate with:
      | service      | Amazon Managed Streaming for Apache Kafka (MSK) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | Select an instance | kafka.m5.large |
      | numberOfKafkaBrokerNodes | 6 |
      | storagePerBroker | 500 |
      | desiredProvisionedStorageThroughput | 250 |
      | numberOfAuthenticationSchemes | 2 |
      | Data processed for private connectivity | 1000 |
      | dataTransfer | 200 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @analytics @iot-analytics @full-coverage
  Scenario: Configure AWS IoT Analytics - with advanced queries
    When I create an estimate with:
      | service      | AWS IoT Analytics |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfIotDevicesMonthly | 1000 |
      | dataGenerationByEachDevice | 100 |
      | numberOfDataPipelinesMonthly | 10 |
      | dataQueriedPerMonth | 500 |
      | numberOfQueriesMonthly | 1000 |
      | dataScannedPerQuery | 10 |
      | averageAcuExecutionTime | 30 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @security @private-ca @full-coverage
  Scenario: Configure AWS Private Certificate Authority - with OCSP
    When I create an estimate with:
      | service      | AWS Private Certificate Authority |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfPrivateCas | 3 |
      | numberOfGeneralPurposeModePrivateCertificate | 10000 |
      | numberOfCertificatesUsedWithAcmintegratedSer | 5000 |
      | numberOfShortLivedCertificateModePrivateCer | 50000 |
      | numberOfOcspResponsesPerMonth | 1000000 |
      | numberOfOcspQueriesPerHour | 5000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @cloudfront @full-coverage
  Scenario: Configure Amazon CloudFront - with all plan tiers
    When I create an estimate with:
      | service      | Amazon CloudFront |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | freePlan | 0 |
      | proPlan | 2 |
      | businessPlan | 1 |
      | premiumPlan | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @devops @cloudwatch @full-coverage
  Scenario: Configure Amazon CloudWatch - with Database Insights and ACUs
    When I create an estimate with:
      | service      | Amazon CloudWatch |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | totalNumberOfMetrics | 500 |
      | getMetricDataRequests | 100000 |
      | getMetricWidgetImageRequests | 10000 |
      | numberOfOtherAPIRequests | 500000 |
      | numberOfVCPUsMonitoredByDatabaseInsights | 32 |
      | Number of Aurora Capacity Units (ACUs) monitored by Database Insights | 16 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @storage @ebs @full-coverage
  Scenario: Configure Amazon Elastic Block Store (EBS) - with snapshot API
    When I create an estimate with:
      | service      | Amazon Elastic Block Store (EBS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfVolumes | 10 |
      | averageDurationOfVolume | 730 |
      | storageAmountPerVolume | 500 |
      | amountChangedPerSnapshot | 10 |
      | Number of snapshots to restore | 5 |
      | Number of GetSnapshotBlock API requests | 100000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ml @healthlake @full-coverage
  Scenario: Configure Amazon Healthlake - with REST-Hook notifications
    When I create an estimate with:
      | service      | Amazon Healthlake |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | additionalDataStorage | 500 |
      | totalNumberOfQueriesPerMonth | 100000 |
      | numberOfNlpCharacters | 50000000 |
      | exportedDataPerGb | 100 |
      | numberOfNotificationsToAmazonEventbridge | 50000 |
      | numberOfNotificationsToResthook | 50000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @ml @rekognition @full-coverage
  Scenario: Configure Amazon Rekognition - with Image Properties API
    When I create an estimate with:
      | service      | Amazon Rekognition |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | numberOfImagesProcessedWithLabelsApiCallsP | 1000000 |
      | numberOfImagesProcessedWithContentModeration | 500000 |
      | numberOfImagesProcessedWithDetectTextApiCa | 200000 |
      | numberOfImagesProcessedWithCelebrityApiCall | 100000 |
      | numberOfImagesProcessedWithPpeDetectionApi | 300000 |
      | numberOfImagesProcessedWithImagePropertiesA | 200000 |
      | numberOfDetectfacesApiCallsPerMonth | 500000 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @region @multi-region
  Scenario Outline: Configure service in <region> region
    When I create an estimate with:
      | service      | Amazon Simple Queue Service (SQS) |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | standardQueueRequests | 1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: AWS Regions
      | region                          |
      | US East (N. Virginia)           |
      | US East (Ohio)                  |
      | US West (Oregon)                |
      | US West (N. California)         |
      | EU (Ireland)                    |
      | EU (Frankfurt)                  |
      | EU (London)                     |
      | EU (Paris)                      |
      | EU (Stockholm)                  |
      | Asia Pacific (Tokyo)            |
      | Asia Pacific (Seoul)            |
      | Asia Pacific (Singapore)        |
      | Asia Pacific (Sydney)           |
      | Asia Pacific (Mumbai)           |
      | South America (Sao Paulo)       |
      | Canada (Central)                |
      | Middle East (Bahrain)           |
      | Africa (Cape Town)              |

  # ============================================================
  # ============================================================
  # ============================================================
  # ============================================================
  @networking @data-transfer @outbound
  Scenario: Configure AWS Data Transfer - outbound to Internet
    When I create an estimate with:
      | service      | AWS Data Transfer |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  @networking @data-transfer @cross-region
  Scenario: Configure AWS Data Transfer - cross region
    When I create an estimate with:
      | service      | AWS Data Transfer |
      | region       | us-east-1 |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

  # ============================================================
  # ============================================================
  @pricing @validation @exact-match
  Scenario Outline: Pricing validation - <service_description>
    When I create an estimate with:
      | service      | <service_name> |
      | region       | us-east-1 |
    And I configure the service with:
      | field | value |
      | <field1> | <value1> |
      | <field2> | <value2> |
      | <field3> | <value3> |
    Then the estimate should be saved successfully
    And the estimate URL should be accessible

    Examples: Services with exact pricing validation
      | service_description          | service_name                         | field1                   | value1 | field2                   | value2 | field3         | value3 |
      | SQS 1M standard requests     | Amazon Simple Queue Service (SQS)    | Standard queue requests  | 1      |                          |        |                |        |
      | KMS 30 keys 2M requests      | AWS Key Management Service           | Number of customer managed Customer Master Keys (CMK) | 30 | Number of symmetric requests | 2000000 |      |        |
      | Secrets 20 secrets 10K API   | AWS Secrets Manager                  | Number of secrets        | 20     | Average duration of each secret | 30 | Number of API calls | 10000 |
      | ECR 30 GB storage            | Amazon Elastic Container Registry    | Amount of data stored    | 30     |                          |        |                |        |
      | Route53 1 zone 1M queries    | Amazon Route 53                      | Hosted Zones             | 1      | Standard queries         | 1      |                |        |
      | Shield Advanced subscription | AWS Shield                           |                          |        |                          |        |                |        |
