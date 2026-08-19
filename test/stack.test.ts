/**
 * CloudFormation template assertions for the stack. Synthesizes with blank
 * Google credentials (the default), so it also proves synth works without a
 * configured IdP.
 */
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MocksHostStack } from '../lib/mocks-host-stack';

function synth(context: Record<string, string> = {}) {
  const app = new App({ context });
  const stack = new MocksHostStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('MocksHostStack', () => {
  const template = synth();

  it('creates three S3 buckets', () => {
    template.resourceCountIs('AWS::S3::Bucket', 3);
  });

  it('blocks public access on every bucket', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const b of Object.values(buckets)) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('gives the staging bucket a 30-day lifecycle and PUT CORS', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' }),
        ]),
      },
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({ AllowedMethods: ['PUT'] }),
        ]),
      },
    });
  });

  it('runs the handler Lambda on Node 20', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
    });
  });

  it('gives the processor a full vCPU and headroom for a decompressed bundle', () => {
    // 1769 MB == 1 vCPU. The processor holds an archive plus its decompressed
    // contents in memory and writes dozens of objects concurrently.
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1769,
      Timeout: 120,
    });
  });

  it('passes the public origin to the handler for absolute URLs in galleries', () => {
    // Generated gallery pages need an absolute og:image for link unfurls, and
    // the Lambda has no other way to learn the domain it is served from.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ SHARE_BASE_URL: Match.anyValue() }),
      },
    });
  });

  it('does not reserve Lambda concurrency (correctness comes from conditional writes)', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  it('wires an S3 -> Lambda notification filtered to uploads/', () => {
    // The custom resource that manages bucket notifications carries the filter.
    const notifications = template.findResources('Custom::S3BucketNotifications');
    expect(Object.keys(notifications).length).toBeGreaterThan(0);
    const json = JSON.stringify(notifications);
    expect(json).toContain('uploads/');
  });

  it('creates a Cognito user pool with self sign-up disabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('attaches a PreSignUp trigger', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PreSignUp: Match.anyValue() },
    });
  });

  it('creates a public OAuth client (no secret) with auth-code grant', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: ['code'],
      GenerateSecret: false,
      AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
    });
  });

  it('creates a CloudFront distribution with the expected behaviors', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    const dist = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0] as any;
    const config = dist.Properties.DistributionConfig;
    const patterns = (config.CacheBehaviors ?? []).map((b: any) => b.PathPattern);
    expect(patterns).toEqual(
      expect.arrayContaining(['/login', '/admin', '/upload', '/app/*', '/status/*']),
    );
  });

  it('defines two CloudFront functions', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 2);
  });

  it('creates an HTTP API with a Cognito JWT authorizer and four routes', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 4);
  });

  it('grants the handler CloudFront invalidation permission', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'cloudfront:CreateInvalidation' }),
        ]),
      },
    });
  });

  it('deploys the admin app under the app/ prefix', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'app',
    });
  });

  it('wires the Google IdP when credentials are supplied', () => {
    const t = synth({
      'mocksHost:googleClientId': 'gid.apps.googleusercontent.com',
      'mocksHost:googleClientSecret': 'gsecret',
    });
    t.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 1);
    t.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'Google',
    });
  });

  it('omits the Google IdP when credentials are blank (default)', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });
});
