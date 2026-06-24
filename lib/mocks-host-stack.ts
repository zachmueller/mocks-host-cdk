import * as path from 'path';
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
  SecretValue,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

/**
 * Single-stack implementation of the mocks host.
 *
 * Dependency direction (kept acyclic, all within one stack):
 *
 *   buckets ─▶ distribution(domain token) ─┬▶ Cognito callback URLs
 *                                           ├▶ HTTP API CORS allowOrigins
 *                                           └▶ config.json ─▶ BucketDeployment
 *   userPool ─▶ userPoolClient ─▶ authorizer ─▶ HTTP API routes ─▶ config.json
 *
 * The only edge into BucketDeployment is the (deployment ─▶ distribution)
 * reference used for cache invalidation; the distribution never references the
 * deployment, so there is no cycle.
 */
export class MocksHostStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- context / config ---------------------------------------------------
    const allowedEmails = this.ctx('mocksHost:allowedEmails', 'jessicaxu@example.com,zmueller@example.com');
    const hostedUiPrefix = this.ctx('mocksHost:hostedUiPrefix', 'mocks-host-admin');
    const customDomain = this.ctx('mocksHost:customDomain', '');
    const googleClientId = this.ctx('mocksHost:googleClientId', '');
    const googleClientSecret = this.ctx('mocksHost:googleClientSecret', '');

    const region = Stack.of(this).region;
    const hostedUiDomain = `${hostedUiPrefix}.auth.${region}.amazoncognito.com`;

    // =========================================================================
    // S3 buckets
    // =========================================================================
    // The staging bucket is created later (after the distribution) because its
    // CORS rule references the CloudFront domain. The distribution only needs
    // the assets bucket, so this ordering stays acyclic.

    // Public-facing assets (served only through CloudFront OAC). Holds
    // <uid>/..., the admin app under app/..., and status/<uid>.json.
    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Private metadata index — only the Lambda role ever touches it.
    const metadataBucket = new s3.Bucket(this, 'MetadataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const METADATA_KEY = 'metadata.json';

    // =========================================================================
    // CloudFront functions (viewer-request URL rewriting)
    // =========================================================================
    const cleanUrlFn = new cloudfront.Function(this, 'CleanUrlFn', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, 'cloudfront-functions', 'clean-url.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Clean URLs for /<uid> content (default behavior only)',
    });

    const adminRewriteFn = new cloudfront.Function(this, 'AdminRewriteFn', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, 'cloudfront-functions', 'admin-rewrite.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Map /login /admin /upload to app/*.html',
    });

    // =========================================================================
    // CloudFront distribution
    // =========================================================================
    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(assetsBucket);

    // 1-year immutable cache for UID content.
    const immutableCache = new cloudfront.CachePolicy(this, 'ImmutableCache', {
      defaultTtl: Duration.days(365),
      minTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Short cache for the admin app shell (re-deployed periodically).
    const shortCache = new cloudfront.CachePolicy(this, 'ShortCache', {
      defaultTtl: Duration.seconds(60),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(300),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Near-live cache for status polling; allow zero-TTL so freshly-flipped
    // status is visible quickly.
    const statusCache = new cloudfront.CachePolicy(this, 'StatusCache', {
      defaultTtl: Duration.seconds(5),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(10),
    });

    const cleanUrlAssoc: cloudfront.FunctionAssociation[] = [
      { function: cleanUrlFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];
    const adminAssoc: cloudfront.FunctionAssociation[] = [
      { function: adminRewriteFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Mocks host',
      defaultBehavior: {
        origin: assetsOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: immutableCache,
        functionAssociations: cleanUrlAssoc,
      },
      additionalBehaviors: {
        // Admin app shell (served from app/*.html via the rewrite function).
        '/login': this.adminBehavior(assetsOrigin, shortCache, adminAssoc),
        '/admin': this.adminBehavior(assetsOrigin, shortCache, adminAssoc),
        '/upload': this.adminBehavior(assetsOrigin, shortCache, adminAssoc),
        // Static admin assets (app.js, styles.css, config.json) — no rewrite.
        '/app/*': {
          origin: assetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: shortCache,
        },
        // Upload status polling.
        '/status/*': {
          origin: assetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: statusCache,
        },
      },
      defaultRootObject: '',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const cloudFrontDomain = distribution.distributionDomainName;

    // Raw uploads land here via presigned PUT; auto-expire after 30 days.
    // Created after the distribution so its CORS can allow the CloudFront origin
    // (where the upload page is served from) plus the optional custom domain.
    const stagingBucket = new s3.Bucket(this, 'StagingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: this.browserOrigins(customDomain, cloudFrontDomain),
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // =========================================================================
    // Cognito (user pool + Google IdP + Hosted UI + app client)
    // =========================================================================
    const preSignUpFn = new NodejsFunction(this, 'PreSignUpFn', {
      entry: path.join(__dirname, 'lambda', 'pre-signup.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: { ALLOWED_EMAILS: allowedEmails },
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // invite/allowlist only; no public sign-up
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      removalPolicy: RemovalPolicy.DESTROY,
      lambdaTriggers: { preSignUp: preSignUpFn },
    });

    // Google federation is only wired when credentials are supplied, so synth
    // and tests pass with blank context. Supply real values before deploy.
    let googleIdp: cognito.UserPoolIdentityProviderGoogle | undefined;
    const supportedIdps: cognito.UserPoolClientIdentityProvider[] = [];
    if (googleClientId && googleClientSecret) {
      googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdp', {
        userPool,
        clientId: googleClientId,
        clientSecretValue: this.secret(googleClientSecret),
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        },
      });
      supportedIdps.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
    } else {
      supportedIdps.push(cognito.UserPoolClientIdentityProvider.COGNITO);
    }

    new cognito.UserPoolDomain(this, 'HostedUiDomain', {
      userPool,
      cognitoDomain: { domainPrefix: hostedUiPrefix },
    });

    const callbackUrls = this.callbackUrls(cloudFrontDomain, customDomain, '/login');
    const logoutUrls = callbackUrls;

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      generateSecret: false, // public SPA client (PKCE)
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls,
      },
      supportedIdentityProviders: supportedIdps,
    });
    // Ensure the Google IdP exists before the client references it.
    if (googleIdp) userPoolClient.node.addDependency(googleIdp);

    // =========================================================================
    // Multi-action Lambda (router + S3 processor)
    // =========================================================================
    const handlerFn = new NodejsFunction(this, 'HandlerFn', {
      entry: path.join(__dirname, 'lambda', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.minutes(2),
      // Metadata.json read-modify-writes are serialized by S3 conditional
      // writes (optimistic concurrency with retry) inside the handler, so no
      // reserved concurrency is needed — and a new account's default
      // concurrency limit (10) won't even permit reserving any.
      environment: {
        STAGING_BUCKET: stagingBucket.bucketName,
        ASSETS_BUCKET: assetsBucket.bucketName,
        METADATA_BUCKET: metadataBucket.bucketName,
        METADATA_KEY,
        ALLOWED_EMAILS: allowedEmails,
        DISTRIBUTION_ID: distribution.distributionId,
      },
      bundling: {
        // fflate is bundled; AWS SDK v3 is provided by the Node 20 runtime.
        externalModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/s3-request-presigner',
          '@aws-sdk/client-cloudfront',
        ],
      },
    });

    // S3 event: only user uploads (prefix uploads/) trigger the processor.
    // The presign sidecar writes (prefix meta/) are excluded by this filter,
    // and processor output goes to a different bucket, so no self-trigger.
    stagingBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(handlerFn),
      { prefix: 'uploads/' },
    );

    // --- IAM grants (least privilege) ---------------------------------------
    stagingBucket.grantReadWrite(handlerFn); // presign sidecar + read upload
    assetsBucket.grantReadWrite(handlerFn);   // write <uid>/, status/, delete
    metadataBucket.grantReadWrite(handlerFn); // metadata.json
    // Delete-time edge invalidation.
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${distribution.distributionId}`,
        ],
      }),
    );

    // =========================================================================
    // HTTP API (Cognito JWT authorizer) -> Lambda
    // =========================================================================
    const authorizer = new HttpUserPoolAuthorizer('Authorizer', userPool, {
      userPoolClients: [userPoolClient],
    });
    const integration = new HttpLambdaIntegration('HandlerIntegration', handlerFn);

    const httpApi = new apigwv2.HttpApi(this, 'AdminApi', {
      corsPreflight: {
        allowOrigins: this.browserOrigins(customDomain, cloudFrontDomain),
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    for (const action of ['presign', 'list', 'edit', 'delete']) {
      httpApi.addRoutes({
        path: `/${action}`,
        methods: [apigwv2.HttpMethod.POST],
        integration,
        authorizer,
      });
    }

    const apiUrl = httpApi.apiEndpoint;

    // =========================================================================
    // Deploy the admin SPA + a synthesized config.json
    // =========================================================================
    // prune is scoped to the app/ prefix so it never touches runtime <uid>/
    // content written by the processor.
    new s3deploy.BucketDeployment(this, 'DeployAdminApp', {
      destinationBucket: assetsBucket,
      destinationKeyPrefix: 'app',
      prune: false,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'admin-app')),
        s3deploy.Source.jsonData('config.json', {
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
          hostedUiDomain,
          apiUrl,
          cloudFrontDomain,
          shareDomain: customDomain || cloudFrontDomain,
        }),
      ],
      distribution,
      distributionPaths: ['/login', '/admin', '/upload', '/app/*'],
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new CfnOutput(this, 'CloudFrontDomain', { value: cloudFrontDomain });
    new CfnOutput(this, 'AdminLoginUrl', { value: `https://${cloudFrontDomain}/login` });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomainOut', { value: hostedUiDomain });
    new CfnOutput(this, 'GoogleRedirectUri', {
      value: `https://${hostedUiDomain}/oauth2/idpresponse`,
      description: 'Set this as the authorized redirect URI in the Google OAuth client',
    });
    new CfnOutput(this, 'StagingBucketName', { value: stagingBucket.bucketName });
    new CfnOutput(this, 'AssetsBucketName', { value: assetsBucket.bucketName });
  }

  // ---- helpers -------------------------------------------------------------

  private ctx(key: string, fallback: string): string {
    const v = this.node.tryGetContext(key);
    return v === undefined || v === null || v === '' ? fallback : String(v);
  }

  /** Wrap a plaintext secret from context; for deploy, prefer SecretsManager. */
  private secret(value: string): SecretValue {
    return SecretValue.unsafePlainText(value);
  }

  /**
   * Browser origins allowed to call the API / PUT to staging. The admin app is
   * served from the CloudFront domain (and, later, the custom domain), so those
   * are the cross-origin callers to the HTTP API and the S3 staging bucket.
   */
  private browserOrigins(customDomain: string, cloudFrontDomain: string): string[] {
    const origins = ['http://localhost:5173', 'http://localhost:8080'];
    origins.push(`https://${cloudFrontDomain}`);
    if (customDomain) origins.push(`https://${customDomain}`);
    return origins;
  }

  /** Cognito callback/logout URLs (CloudFront domain + optional custom). */
  private callbackUrls(cfDomain: string, customDomain: string, path: string): string[] {
    const urls = [`https://${cfDomain}${path}`];
    if (customDomain) urls.push(`https://${customDomain}${path}`);
    return urls;
  }

  private adminBehavior(
    origin: cloudfront.IOrigin,
    cachePolicy: cloudfront.ICachePolicy,
    assoc: cloudfront.FunctionAssociation[],
  ): cloudfront.BehaviorOptions {
    return {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy,
      functionAssociations: assoc,
    };
  }
}
