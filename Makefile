.PHONY: init-state-bucket pulumi-configure create-stack deploy-dev destroy-dev

init-state-bucket:
	sh ./bootstrap-state-bucket.sh

pulumi-configure:
	pulumi login s3://project-name-pulumi-state-dev

create-stack:
	pulumi stack init dev

deploy-dev:
	pulumi up --stack dev

destroy-dev:
	pulumi destroy --stack dev