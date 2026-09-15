# Icon credits and licenses

DR Compass renders architecture diagrams using official icon sets from the
vendors and projects listed below. All trademarks, service marks, logos, and
brand assets remain the property of their respective owners. They are included
here solely to identify the corresponding services, products, and projects in
user-created architecture diagrams, and their use does not imply any
affiliation with or endorsement by the trademark owners.

Icons live under `web/assets/icons/<set>/` and are indexed by
`web/assets/icons/manifest.json`. Each SVG was normalized (editor metadata
stripped, viewBox verified) but the official artwork and colors are unchanged.

## AWS Architecture Icons (`web/assets/icons/aws/`)

- **Source:** Official AWS Architecture Icons asset package (release 07/31/2026),
  downloaded from https://aws.amazon.com/architecture/icons/
  (`d1.awsstatic.com/.../Icon-package_07312026...zip`).
- **License / terms:** Provided by Amazon Web Services for use in architecture
  diagrams, per the guidance distributed with the asset package and the AWS
  Site Terms (https://aws.amazon.com/terms/). AWS, the Powered by AWS logo, and
  the service icons/names are trademarks of Amazon.com, Inc. or its affiliates.
- **Subset included:** 59 icons — the 48px "Architecture-Service" family
  (compute, containers, database, storage, networking, security, messaging,
  management, and resilience services such as AWS Elastic Disaster Recovery,
  Amazon Application Recovery Controller, and AWS Resilience Hub), plus a few
  48px "Resource" icons (ALB, NLB, NAT gateway, internet gateway) and
  "Architecture-Group" icons (subnet, region) where no service icon exists.

## Kubernetes icons (`web/assets/icons/k8s/`)

- **Source:** Official Kubernetes community icon set,
  https://github.com/kubernetes/community/tree/master/icons
  (labeled `resources`, `infrastructure_components` sets), and the Kubernetes
  logo from https://github.com/kubernetes/kubernetes/tree/master/logo.
- **License:** CC BY 4.0 (attribution: The Kubernetes Authors / the Kubernetes
  community icons project). Kubernetes and the Kubernetes logo are trademarks
  of The Linux Foundation.
- **Subset included:** 17 icons — Kubernetes logo, Pod, Deployment, Service,
  Namespace, Ingress, ConfigMap, Secret, StatefulSet, DaemonSet, Job, CronJob,
  PersistentVolume, PersistentVolumeClaim, HorizontalPodAutoscaler, Node,
  CustomResourceDefinition. (The community set has no etcd icon; the CNCF etcd
  project icon below is used for etcd.)

## CNCF project icons (`web/assets/icons/cncf/`)

- **Source:** Official CNCF artwork repository,
  https://github.com/cncf/artwork (`projects/<name>/icon/color/`).
- **License / terms:** Provided by the Cloud Native Computing Foundation; usage
  is governed by the Linux Foundation Trademark Usage Guidelines
  (https://www.linuxfoundation.org/legal/trademark-usage). Each project logo is
  a trademark of The Linux Foundation and/or the respective project.
- **Subset included:** Argo, Helm, Prometheus, Istio, etcd (icon/color
  variants).

## Other project icons (`web/assets/icons/cncf/`)

- **Git logo** (`cncf/git.svg`): by Jason Long, from
  https://git-scm.com/downloads/logos, licensed CC BY 3.0
  (https://creativecommons.org/licenses/by/3.0/).
- **GitHub mark** (`cncf/github.svg`): the `mark-github` icon from GitHub's
  official Octicons set, https://github.com/primer/octicons, MIT license. The
  GitHub logo is a trademark of GitHub, Inc.; used only to identify GitHub.
- **Grafana icon** (`cncf/grafana.svg`): from the Grafana open-source
  repository, https://github.com/grafana/grafana (`public/img/grafana_icon.svg`,
  repository licensed AGPL-3.0). Grafana is not a CNCF project and its icon is
  not in cncf/artwork; the Grafana name and logo are trademarks of Grafana Labs
  (Raintank, Inc.) and are used here solely to identify Grafana. If this is a
  concern for your deployment, delete `cncf/grafana.svg` and remove its
  manifest entries — components fall back to the generic observability icon.

## Deliberately not included

- **Terraform / HashiCorp logos:** HashiCorp's brand guidelines place stricter
  conditions on logo redistribution, so no HashiCorp artwork is bundled.
  Terraform-related components fall back to the generic CI/CD icon.

## Generic fallback icons (`web/assets/icons/generic/`)

- **Source:** Original artwork created for DR Compass (simple rounded-square
  glyphs, `currentColor`-based). 15 icons: service, database, queue, storage,
  external, saas, network, secret, observability, people, cicd, dns, cdn,
  region, partner.
- **License:** Same license as the DR Compass repository; no third-party
  artwork involved.
