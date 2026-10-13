# Shortcuts. Prefer plain `docker compose` commands? See README.md.
.PHONY: secrets base build up down logs ps clean

secrets:      ## create random passwords in ./secrets (skips existing ones)
	sh scripts/generate-secrets.sh

base:         ## build the two custom base images
	docker compose --profile base build api-base web-base

build: base   ## build base images, then the web and api images
	docker compose build

up: secrets build  ## everything: secrets -> base images -> app images -> start
	docker compose up -d
	@echo "Open http://localhost:$${HTTP_PORT:-8080}"

down:         ## stop and remove containers (data volumes are kept)
	docker compose down

logs:         ## follow logs of all services
	docker compose logs -f --tail=50

ps:           ## show containers and their health
	docker compose ps

clean:        ## stop everything AND delete the data volumes (DESTROYS DATA)
	docker compose down -v
